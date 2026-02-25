---
name: print
description: Send a file to the printer. Use after generating documents, PDFs, or reports.
argument-hint: [file path]
---

# Print Documents

When the user asks you to print, or you've just finished generating a document and they want it printed:

## Workflow

1. **Discover printers** — call `list_printers` to see what's available and online
2. **Discover capabilities** — call `get_printer_capabilities` with the target printer to see ALL its options
3. **Print** — call `print_file` with the file path, a `coverNote`, and any options
4. **Confirm** — tell the user the job was sent, which printer, and what options were applied

## Cover Sheet (automatic)

Every print job automatically prints a cover sheet first — a single Letter page with:
- Document name
- Date and time
- A short note from you (Claude)

You MUST provide a `coverNote` — a witty, light one-liner. Keep it office-friendly and genuinely funny. It should feel like a coworker left a sticky note. Vary your humor — don't repeat the same joke twice.

Good examples:
- "Printed before you even sat down. You're welcome."
- "I made this while you were in the meeting about the meeting."
- "Fun fact: I read this entire document in 0.2 seconds. The meeting to discuss it will take 3 hours."
- "This one's on me. Literally. I don't get paid."

## How options work

Every printer exposes different capabilities. The `get_printer_capabilities` tool returns the actual CUPS options for that specific printer — option names, possible values, and the current default (marked with *).

Pass options to `print_file` as a key-value record. Use the exact option names and values from `get_printer_capabilities`.

### Common options you'll see

| Option | What it controls | Example values |
|--------|-----------------|----------------|
| `Duplex` | Double-sided printing | `None`, `DuplexNoTumble` (long-edge), `DuplexTumble` (short-edge) |
| `ColorModel` | Color vs B&W | `RGB`, `Gray`, `CMYK` |
| `PageSize` | Paper size | `Letter`, `Legal`, `A4`, `Tabloid`, `11x17` |
| `cupsPrintQuality` | Print quality | `Draft`, `Normal`, `High` |
| `StapleLocation` | Stapling | `None`, `SinglePortrait`, etc. |
| `MediaType` | Paper type | `auto`, `stationery`, `cardstock`, `transparency` |
| `InputSlot` | Paper tray | `auto`, `tray-1`, `tray-2`, etc. |

Large-format printers (e.g. HP DesignJet) will have different options like roll media, print quality DPI, margins, etc.

**Always check capabilities first** — don't assume options exist on a printer.

## When to proactively offer printing

If the user says things like:
- "print this", "send to printer", "hard copy"
- "print it when done"
- "I'll grab it from the printer"

## Example

User: "Generate a sales report PDF and print 2 copies, stapled, black and white on legal paper"

1. Generate the PDF
2. `list_printers` → find the online printer
3. `get_printer_capabilities` → confirm it supports stapling, B&W, legal
4. `print_file` with:
   - `copies: 2`
   - `options: {"ColorModel": "Gray", "PageSize": "Legal", "StapleLocation": "SinglePortrait"}`
5. Confirm: "Sent 2 copies to Xerox AltaLink C8030 — B&W, legal, stapled top-left"
