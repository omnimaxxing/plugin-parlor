#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, writeFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
const exec = promisify(execFile);
// --- Helpers ---
async function runCommand(cmd, args) {
    try {
        return await exec(cmd, args, { timeout: 15_000 });
    }
    catch (err) {
        const e = err;
        throw new Error(e.stderr || e.message);
    }
}
function parsePrinterLine(line) {
    const match = line.match(/^printer\s+(\S+)\s+(.*)/);
    if (!match)
        return null;
    const name = match[1];
    const rest = match[2];
    const enabled = !rest.includes("disabled");
    const status = enabled
        ? rest.replace(/\.$/, "").trim()
        : rest.replace(/disabled since.*/, "disabled").trim();
    return { name, status, enabled };
}
/**
 * Parse lpoptions -l output into structured capabilities.
 *
 * Each line from CUPS looks like:
 *   OptionName/Human Label: value1 *defaultValue value2
 *
 * The asterisk marks the current default.
 */
function parseCapabilities(raw) {
    const options = [];
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        // Split "OptionName/Label: val1 *val2 val3"
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx === -1)
            continue;
        const keyPart = trimmed.slice(0, colonIdx).trim();
        const valPart = trimmed.slice(colonIdx + 1).trim();
        // Parse key — may be "Name/Label" or just "Name"
        let name;
        let label;
        const slashIdx = keyPart.indexOf("/");
        if (slashIdx !== -1) {
            name = keyPart.slice(0, slashIdx);
            label = keyPart.slice(slashIdx + 1);
        }
        else {
            name = keyPart;
            label = keyPart;
        }
        // Parse values — asterisk prefix marks the default
        const values = [];
        let defaultVal = null;
        for (const token of valPart.split(/\s+/)) {
            if (!token)
                continue;
            if (token.startsWith("*")) {
                const val = token.slice(1);
                values.push(val);
                defaultVal = val;
            }
            else {
                values.push(token);
            }
        }
        options.push({ name, label, values, default: defaultVal });
    }
    return options;
}
/**
 * Format capabilities into a readable string for Claude.
 * Groups options into logical categories for easier reading.
 */
function formatCapabilities(options) {
    const lines = [];
    for (const opt of options) {
        const defaultMarker = opt.default ? ` (default: ${opt.default})` : "";
        const valuesStr = opt.values.length <= 10
            ? opt.values.join(", ")
            : opt.values.slice(0, 10).join(", ") +
                ` ... and ${opt.values.length - 10} more`;
        lines.push(`  ${opt.name} [${opt.label}]${defaultMarker}`);
        lines.push(`    values: ${valuesStr}`);
    }
    return lines.join("\n");
}
/**
 * Generate a cover sheet as a plain text file.
 * Returns the path to a temp file that should be cleaned up after printing.
 */
async function generateCoverSheet(fileName, coverNote) {
    const now = new Date();
    const date = now.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
    });
    const time = now.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    });
    const lines = [
        `DOCUMENT:  ${fileName}`,
        `DATE:      ${date}`,
        `TIME:      ${time}`,
        "",
        "",
        `"${coverNote}"`,
        "",
        "  — Claude",
        "",
    ];
    const content = lines.join("\n");
    const tmpPath = join(tmpdir(), `coversheet-${randomBytes(6).toString("hex")}.txt`);
    await writeFile(tmpPath, content, "utf-8");
    return tmpPath;
}
/**
 * Discover printers on the network via Bonjour/mDNS.
 * Uses dns-sd to browse for _ipp._tcp and _ipps._tcp services.
 * Returns deduplicated printer names with their URIs.
 */
async function discoverNetworkPrinters(timeoutSec = 4) {
    // Run dns-sd with a timeout — it runs forever so we kill it
    const results = [];
    const seen = new Set();
    // Browse both IPP and IPPS
    for (const service of ["_ipp._tcp", "_ipps._tcp"]) {
        try {
            const { stdout } = await new Promise((resolve, reject) => {
                const proc = execFile("dns-sd", ["-B", service], { timeout: (timeoutSec + 1) * 1000 }, (err, stdout, stderr) => {
                    // dns-sd always "fails" because we kill it
                    resolve({ stdout: stdout || "", stderr: stderr || "" });
                });
                setTimeout(() => proc.kill(), timeoutSec * 1000);
            });
            for (const line of stdout.split("\n")) {
                // Parse: "Timestamp  A/R  Flags  if  Domain  ServiceType  InstanceName"
                const match = line.match(/^\d+:\d+:\d+\.\d+\s+Add\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+(.+)$/);
                if (!match)
                    continue;
                const name = match[3].trim();
                if (seen.has(name))
                    continue;
                seen.add(name);
                results.push({ name, uri: `${service} on ${match[1]}` });
            }
        }
        catch {
            // dns-sd not available or timed out, skip
        }
    }
    // Also get URIs from ippfind for printers that respond
    try {
        const { stdout: ippOut } = await exec("ippfind", ["-T", String(timeoutSec)], {
            timeout: (timeoutSec + 2) * 1000,
        }).catch(() => ({ stdout: "" }));
        // Store ippfind URIs by hostname for matching
        const ippUris = ippOut
            .trim()
            .split("\n")
            .filter(Boolean);
        // Try to match ippfind URIs back to dns-sd results by hostname
        for (const uri of ippUris) {
            try {
                const hostname = new URL(uri).hostname.replace(".local.", ".local");
                // Update any matching result with the actual IPP URI
                for (const r of results) {
                    if (hostname.toLowerCase().includes(r.name
                        .replace(/[^a-zA-Z0-9]/g, "")
                        .substring(0, 8)
                        .toLowerCase()) ||
                        r.name.toLowerCase().includes(hostname.replace(".local", "").substring(0, 8).toLowerCase())) {
                        r.uri = uri;
                    }
                }
            }
            catch {
                // URL parse failed, skip
            }
        }
    }
    catch {
        // ippfind not available
    }
    return results;
}
// --- Server ---
const server = new McpServer({
    name: "printer",
    version: "2.1.0",
});
// Tool: list_printers
server.tool("list_printers", "List all available printers and their status. Call this first to see what printers are available.", {}, async () => {
    const { stdout: printersOut } = await runCommand("lpstat", ["-p"]);
    const { stdout: defaultOut } = await runCommand("lpstat", ["-d"]);
    const defaultMatch = defaultOut.match(/system default destination:\s+(\S+)/);
    const defaultPrinter = defaultMatch ? defaultMatch[1] : null;
    const printers = printersOut
        .split("\n")
        .map(parsePrinterLine)
        .filter(Boolean);
    if (printers.length === 0) {
        return {
            content: [
                { type: "text", text: "No printers found on this system." },
            ],
        };
    }
    const lines = printers.map((p) => {
        const isDefault = p.name === defaultPrinter ? " (default)" : "";
        const statusIcon = p.enabled ? "ready" : "offline";
        return `- ${p.name}${isDefault} [${statusIcon}]`;
    });
    return {
        content: [
            {
                type: "text",
                text: [
                    "Available printers:",
                    ...lines,
                    "",
                    "Tip: Call get_printer_capabilities with a printer name to see all its options (paper sizes, duplex, finishing, color modes, etc.)",
                ].join("\n"),
            },
        ],
    };
});
// Tool: get_printer_capabilities
server.tool("get_printer_capabilities", "Discover ALL options a printer supports — paper sizes, duplex, color modes, finishing (stapling, hole punch), media types, trays, quality settings, and more. Every printer exposes different options. Call this to learn what a specific printer can do, then pass the option names and values to print_file.", {
    printer: z.string().describe("Printer name from list_printers"),
}, async ({ printer }) => {
    try {
        const { stdout: statusOut } = await runCommand("lpstat", [
            "-p",
            printer,
        ]);
        const { stdout: optionsOut } = await runCommand("lpoptions", [
            "-p",
            printer,
            "-l",
        ]);
        const capabilities = parseCapabilities(optionsOut);
        const printerStatus = parsePrinterLine(statusOut.trim());
        let text = `Printer: ${printer}\n`;
        text += `Status: ${printerStatus?.enabled ? "ready" : "offline"}\n\n`;
        if (capabilities.length === 0) {
            text += "No configurable options reported by this printer.";
        }
        else {
            text += `${capabilities.length} configurable options:\n\n`;
            text += formatCapabilities(capabilities);
            text += "\n\n";
            text += "To print with specific options, pass them in the 'options' parameter of print_file.\n";
            text += 'Example: options: {"Duplex": "DuplexNoTumble", "ColorModel": "Gray", "StapleLocation": "SinglePortrait"}';
        }
        return { content: [{ type: "text", text }] };
    }
    catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: `Could not query printer "${printer}": ${err.message}`,
                },
            ],
            isError: true,
        };
    }
});
// Tool: print_file
server.tool("print_file", 'Send a file to the printer with an automatic cover sheet. A cover page is ALWAYS printed first with the document name, date, time, and your note. Supports PDF, images, text files, and anything CUPS can handle. Use get_printer_capabilities first to discover available options.', {
    filePath: z
        .string()
        .describe("Absolute path to the file to print"),
    coverNote: z
        .string()
        .describe("A short, witty one-liner from you (Claude) for the cover sheet. Be lightly humorous — this prints on a physical page that people in the office will see."),
    printer: z
        .string()
        .optional()
        .describe("Printer name (omit for default printer)"),
    copies: z
        .number()
        .int()
        .min(1)
        .max(99)
        .optional()
        .describe("Number of copies (default 1)"),
    pages: z
        .string()
        .optional()
        .describe('Page range, e.g. "1-3" or "2,4,6"'),
    options: z
        .record(z.string(), z.string())
        .optional()
        .describe('Printer-specific options as key-value pairs from get_printer_capabilities. Example: {"Duplex": "DuplexNoTumble", "ColorModel": "Gray", "PageSize": "Legal", "StapleLocation": "SinglePortrait", "cupsPrintQuality": "High", "MediaType": "stationery-letterhead", "InputSlot": "tray-2"}'),
}, async ({ filePath, coverNote, printer, copies, pages, options }) => {
    // Verify file exists and is readable
    try {
        await access(filePath, constants.R_OK);
    }
    catch {
        return {
            content: [
                {
                    type: "text",
                    text: `Error: File not found or not readable: ${filePath}`,
                },
            ],
            isError: true,
        };
    }
    // Extract just the filename for the cover sheet
    const fileName = filePath.split("/").pop() || filePath;
    // Build common lpr arguments (printer selection)
    const printerArgs = [];
    if (printer) {
        printerArgs.push("-P", printer);
    }
    // Build CUPS options for the main document
    const docArgs = [...printerArgs];
    if (copies && copies > 1) {
        docArgs.push("-#", String(copies));
    }
    const cupsOptions = [];
    if (pages) {
        cupsOptions.push(`page-ranges=${pages}`);
    }
    if (options) {
        for (const [key, value] of Object.entries(options)) {
            cupsOptions.push(`${key}=${value}`);
        }
    }
    for (const opt of cupsOptions) {
        docArgs.push("-o", opt);
    }
    docArgs.push(filePath);
    let coverSheetPath = null;
    try {
        // 1. Generate and print the cover sheet (always Letter, single-sided)
        coverSheetPath = await generateCoverSheet(fileName, coverNote);
        const coverArgs = [
            ...printerArgs,
            "-o", "PageSize=Letter",
            "-o", "sides=one-sided",
            coverSheetPath,
        ];
        await runCommand("lpr", coverArgs);
        // 2. Print the actual document
        await runCommand("lpr", docArgs);
        // Get the job IDs from the queue
        const { stdout: queueOut } = await runCommand("lpstat", ["-o"]);
        const printerName = printer || "(default)";
        const jobLines = queueOut.trim().split("\n").filter(Boolean);
        // Build summary
        let summary = `Cover sheet + document sent to printer: ${printerName}`;
        summary += `\nCover note: "${coverNote}"`;
        if (copies && copies > 1)
            summary += `\nCopies: ${copies}`;
        if (pages)
            summary += `\nPages: ${pages}`;
        if (options && Object.keys(options).length > 0) {
            summary += "\nOptions:";
            for (const [key, value] of Object.entries(options)) {
                summary += `\n  ${key}: ${value}`;
            }
        }
        if (jobLines.length > 0) {
            summary += `\nLatest jobs:\n  ${jobLines.slice(-2).join("\n  ")}`;
        }
        return {
            content: [{ type: "text", text: summary }],
        };
    }
    catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: `Print failed: ${err.message}`,
                },
            ],
            isError: true,
        };
    }
    finally {
        // Clean up temp cover sheet
        if (coverSheetPath) {
            unlink(coverSheetPath).catch(() => { });
        }
    }
});
// Tool: get_print_queue
server.tool("get_print_queue", "Check the current print queue — see pending/active jobs and their status.", {
    printer: z
        .string()
        .optional()
        .describe("Filter by printer name (omit for all printers)"),
}, async ({ printer }) => {
    const args = printer ? ["-o", printer] : ["-o"];
    try {
        const { stdout } = await runCommand("lpstat", args);
        if (!stdout.trim()) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Print queue is empty — no active jobs.",
                    },
                ],
            };
        }
        return {
            content: [
                {
                    type: "text",
                    text: `Print queue:\n${stdout.trim()}`,
                },
            ],
        };
    }
    catch {
        return {
            content: [
                {
                    type: "text",
                    text: "Print queue is empty — no active jobs.",
                },
            ],
        };
    }
});
// Tool: cancel_print_job
server.tool("cancel_print_job", "Cancel a print job by job ID, or cancel all jobs for a printer.", {
    jobId: z
        .string()
        .optional()
        .describe('Job ID to cancel (e.g. "Xerox_AltaLink-123")'),
    printer: z
        .string()
        .optional()
        .describe("Cancel ALL jobs for this printer"),
}, async ({ jobId, printer }) => {
    if (!jobId && !printer) {
        return {
            content: [
                {
                    type: "text",
                    text: "Provide either a jobId or printer name to cancel jobs.",
                },
            ],
            isError: true,
        };
    }
    try {
        if (jobId) {
            await runCommand("cancel", [jobId]);
            return {
                content: [
                    { type: "text", text: `Cancelled job: ${jobId}` },
                ],
            };
        }
        else {
            await runCommand("cancel", ["-a", printer]);
            return {
                content: [
                    {
                        type: "text",
                        text: `Cancelled all jobs for printer: ${printer}`,
                    },
                ],
            };
        }
    }
    catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: `Cancel failed: ${err.message}`,
                },
            ],
            isError: true,
        };
    }
});
// Tool: discover_printers
server.tool("discover_printers", "Scan the local network for printers via Bonjour/mDNS. Shows ALL printers on the network, including ones not yet added to this Mac. Compare results with list_printers to find printers that need to be added.", {
    timeout: z
        .number()
        .int()
        .min(2)
        .max(15)
        .optional()
        .describe("Network scan timeout in seconds (default 4)"),
}, async ({ timeout }) => {
    const scanTime = timeout || 4;
    try {
        const discovered = await discoverNetworkPrinters(scanTime);
        if (discovered.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: "No printers found on the network. Make sure you're connected to the office network.",
                    },
                ],
            };
        }
        // Get already-configured printers for comparison
        let configured = [];
        try {
            const { stdout } = await runCommand("lpstat", ["-v"]);
            configured = stdout
                .split("\n")
                .map((l) => l.match(/^device for (\S+):/)?.[1])
                .filter(Boolean);
        }
        catch {
            // No printers configured yet
        }
        const lines = discovered.map((p) => {
            // Check if this printer is already configured by matching name fragments
            const nameNorm = p.name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
            const isConfigured = configured.some((c) => c.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().includes(nameNorm.substring(0, 10)) ||
                nameNorm.includes(c.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().substring(0, 10)));
            const status = isConfigured ? " [already added]" : " [not configured]";
            return `- ${p.name}${status}\n    ${p.uri}`;
        });
        return {
            content: [
                {
                    type: "text",
                    text: [
                        `Found ${discovered.length} printers on the network:`,
                        "",
                        ...lines,
                        "",
                        'Printers marked [not configured] can be added with add_printer.',
                    ].join("\n"),
                },
            ],
        };
    }
    catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: `Discovery failed: ${err.message}`,
                },
            ],
            isError: true,
        };
    }
});
// Tool: add_printer
server.tool("add_printer", "Add a network printer to this Mac so you can print to it. Use discover_printers first to find the printer's URI. The printer is added via CUPS using AirPrint/IPP Everywhere drivers (driverless).", {
    name: z
        .string()
        .describe('A short name for the printer (no spaces, used in commands). Example: "DesignJet_T2530"'),
    uri: z
        .string()
        .describe('The printer URI from discover_printers. Example: "ipp://HP3822E28D5A1E.local:631/ipp/print"'),
    description: z
        .string()
        .optional()
        .describe('Human-readable description. Example: "HP DesignJet T2530 - Back Wall"'),
    location: z
        .string()
        .optional()
        .describe('Physical location. Example: "Back office wall"'),
    setDefault: z
        .boolean()
        .optional()
        .describe("Set as the default printer (default false)"),
}, async ({ name, uri, description, location, setDefault }) => {
    // Validate name has no spaces
    if (/\s/.test(name)) {
        return {
            content: [
                {
                    type: "text",
                    text: 'Printer name cannot contain spaces. Use underscores instead, e.g. "DesignJet_T2530".',
                },
            ],
            isError: true,
        };
    }
    try {
        // Add printer using lpadmin with driverless (IPP Everywhere) driver
        const args = [
            "-p", name,
            "-v", uri,
            "-E", // Enable the printer
            "-m", "everywhere", // Use IPP Everywhere / AirPrint driverless
        ];
        if (description) {
            args.push("-D", description);
        }
        if (location) {
            args.push("-L", location);
        }
        await runCommand("lpadmin", args);
        // Set as default if requested
        if (setDefault) {
            await runCommand("lpoptions", ["-d", name]);
        }
        // Verify it was added
        const { stdout: verify } = await runCommand("lpstat", ["-p", name]);
        let text = `Printer "${name}" added successfully!\n`;
        text += `URI: ${uri}\n`;
        if (description)
            text += `Description: ${description}\n`;
        if (location)
            text += `Location: ${location}\n`;
        if (setDefault)
            text += `Set as default printer.\n`;
        text += `\nStatus: ${verify.trim()}`;
        text += `\n\nYou can now use get_printer_capabilities to see its options, then print_file to send documents.`;
        return { content: [{ type: "text", text }] };
    }
    catch (err) {
        const msg = err.message;
        if (msg.includes("forbidden") || msg.includes("not authorized")) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Permission denied adding printer. This may require admin privileges. Try running: sudo lpadmin -p ${name} -v "${uri}" -E -m everywhere`,
                    },
                ],
                isError: true,
            };
        }
        return {
            content: [
                {
                    type: "text",
                    text: `Failed to add printer: ${msg}`,
                },
            ],
            isError: true,
        };
    }
});
// --- Start ---
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((err) => {
    console.error("Server failed to start:", err);
    process.exit(1);
});
