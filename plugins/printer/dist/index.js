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
// --- Server ---
const server = new McpServer({
    name: "printer",
    version: "2.0.0",
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
// --- Start ---
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((err) => {
    console.error("Server failed to start:", err);
    process.exit(1);
});
