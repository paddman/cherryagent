import type { GoogleWorkspaceClient } from "../../connectors/google/GoogleWorkspaceClient.js";
import type { AgentTool } from "../../core/types.js";

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value.trim();
}

function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function optionalStringArray(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function commonMailProperties(): Record<string, unknown> {
  return {
    to: { type: "string", description: "Recipient email address or comma-separated recipients" },
    subject: { type: "string", description: "Email subject" },
    body: { type: "string", description: "Plain-text email body" },
    cc: { type: "string", description: "Optional CC recipients" },
    bcc: { type: "string", description: "Optional BCC recipients" },
  };
}

export function createGoogleWorkspaceTools(client: GoogleWorkspaceClient): AgentTool[] {
  return [
    {
      name: "gmail_search",
      description: "Search the connected Gmail mailbox using Gmail search syntax and return message summaries.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail search query, for example: is:unread newer_than:7d" },
          maxResults: { type: "number", description: "Maximum results from 1 to 50" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (args) =>
        client.gmailSearch(requiredString(args, "query"), optionalNumber(args, "maxResults") ?? 10),
    },
    {
      name: "gmail_read_message",
      description: "Read one Gmail message by message ID, including sender, recipients, subject, labels, snippet, and text body.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { messageId: { type: "string", description: "Gmail message ID" } },
        required: ["messageId"],
        additionalProperties: false,
      },
      execute: async (args) => client.gmailReadMessage(requiredString(args, "messageId")),
    },
    {
      name: "gmail_create_draft",
      description: "Create a Gmail draft without sending it. Use this before sending when review is useful.",
      risk: "write",
      parameters: {
        type: "object",
        properties: commonMailProperties(),
        required: ["to", "subject", "body"],
        additionalProperties: false,
      },
      execute: async (args) =>
        client.gmailCreateDraft({
          to: requiredString(args, "to"),
          subject: requiredString(args, "subject"),
          body: requiredString(args, "body"),
          ...(optionalString(args, "cc") ? { cc: optionalString(args, "cc") } : {}),
          ...(optionalString(args, "bcc") ? { bcc: optionalString(args, "bcc") } : {}),
        }),
    },
    {
      name: "gmail_send_email",
      description: "Send a new email from the connected Gmail account. This requires approval by default.",
      risk: "external",
      parameters: {
        type: "object",
        properties: commonMailProperties(),
        required: ["to", "subject", "body"],
        additionalProperties: false,
      },
      execute: async (args) =>
        client.gmailSendEmail({
          to: requiredString(args, "to"),
          subject: requiredString(args, "subject"),
          body: requiredString(args, "body"),
          ...(optionalString(args, "cc") ? { cc: optionalString(args, "cc") } : {}),
          ...(optionalString(args, "bcc") ? { bcc: optionalString(args, "bcc") } : {}),
        }),
    },
    {
      name: "gmail_reply",
      description: "Reply to an existing Gmail message in its thread. This requires approval by default.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          messageId: { type: "string", description: "Original Gmail message ID" },
          body: { type: "string", description: "Plain-text reply body" },
        },
        required: ["messageId", "body"],
        additionalProperties: false,
      },
      execute: async (args) =>
        client.gmailReply(requiredString(args, "messageId"), requiredString(args, "body")),
    },
    {
      name: "gmail_archive",
      description: "Archive a Gmail message by removing it from the inbox. This changes external mailbox state and requires approval by default.",
      risk: "external",
      parameters: {
        type: "object",
        properties: { messageId: { type: "string", description: "Gmail message ID" } },
        required: ["messageId"],
        additionalProperties: false,
      },
      execute: async (args) => client.gmailArchive(requiredString(args, "messageId")),
    },
    {
      name: "calendar_list_events",
      description: "List events from the primary Google Calendar in a time range, optionally filtered by text query.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          timeMin: { type: "string", description: "ISO-8601 lower time bound" },
          timeMax: { type: "string", description: "ISO-8601 upper time bound" },
          query: { type: "string", description: "Optional free-text event search" },
          maxResults: { type: "number", description: "Maximum events from 1 to 100" },
        },
        additionalProperties: false,
      },
      execute: async (args) =>
        client.calendarListEvents({
          ...(optionalString(args, "timeMin") ? { timeMin: optionalString(args, "timeMin") } : {}),
          ...(optionalString(args, "timeMax") ? { timeMax: optionalString(args, "timeMax") } : {}),
          ...(optionalString(args, "query") ? { query: optionalString(args, "query") } : {}),
          ...(optionalNumber(args, "maxResults") !== undefined
            ? { maxResults: optionalNumber(args, "maxResults") }
            : {}),
        }),
    },
    {
      name: "calendar_create_event",
      description: "Create an event on the primary Google Calendar. Requires approval by default, especially when attendees may receive invitations.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Event title" },
          start: { type: "string", description: "ISO-8601 event start" },
          end: { type: "string", description: "ISO-8601 event end" },
          timeZone: { type: "string", description: "IANA time zone such as Asia/Bangkok" },
          description: { type: "string", description: "Optional event description" },
          location: { type: "string", description: "Optional location" },
          attendees: { type: "array", items: { type: "string" }, description: "Optional attendee email addresses" },
        },
        required: ["summary", "start", "end"],
        additionalProperties: false,
      },
      execute: async (args) =>
        client.calendarCreateEvent({
          summary: requiredString(args, "summary"),
          start: requiredString(args, "start"),
          end: requiredString(args, "end"),
          ...(optionalString(args, "timeZone") ? { timeZone: optionalString(args, "timeZone") } : {}),
          ...(optionalString(args, "description") ? { description: optionalString(args, "description") } : {}),
          ...(optionalString(args, "location") ? { location: optionalString(args, "location") } : {}),
          ...(optionalStringArray(args, "attendees")?.length
            ? { attendees: optionalStringArray(args, "attendees") }
            : {}),
        }),
    },
    {
      name: "calendar_update_event",
      description: "Update an existing Google Calendar event. Requires approval by default.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          eventId: { type: "string", description: "Google Calendar event ID" },
          summary: { type: "string", description: "New title" },
          start: { type: "string", description: "New ISO-8601 start" },
          end: { type: "string", description: "New ISO-8601 end" },
          timeZone: { type: "string", description: "IANA time zone" },
          description: { type: "string", description: "New description" },
          location: { type: "string", description: "New location" },
        },
        required: ["eventId"],
        additionalProperties: false,
      },
      execute: async (args) =>
        client.calendarUpdateEvent(requiredString(args, "eventId"), {
          ...(optionalString(args, "summary") ? { summary: optionalString(args, "summary") } : {}),
          ...(optionalString(args, "start") ? { start: optionalString(args, "start") } : {}),
          ...(optionalString(args, "end") ? { end: optionalString(args, "end") } : {}),
          ...(optionalString(args, "timeZone") ? { timeZone: optionalString(args, "timeZone") } : {}),
          ...(optionalString(args, "description") ? { description: optionalString(args, "description") } : {}),
          ...(optionalString(args, "location") ? { location: optionalString(args, "location") } : {}),
        }),
    },
    {
      name: "calendar_delete_event",
      description: "Delete an existing Google Calendar event. This is destructive and requires explicit approval by default.",
      risk: "dangerous",
      parameters: {
        type: "object",
        properties: { eventId: { type: "string", description: "Google Calendar event ID" } },
        required: ["eventId"],
        additionalProperties: false,
      },
      execute: async (args) => client.calendarDeleteEvent(requiredString(args, "eventId")),
    },
    {
      name: "drive_search_files",
      description: "Search Google Drive files by Drive query, partial name, MIME type, or a combination.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional Google Drive files.list q expression" },
          nameContains: { type: "string", description: "Optional partial file name" },
          mimeType: { type: "string", description: "Optional exact MIME type" },
          maxResults: { type: "number", description: "Maximum results from 1 to 100" },
        },
        additionalProperties: false,
      },
      execute: async (args) =>
        client.driveSearchFiles({
          ...(optionalString(args, "query") ? { query: optionalString(args, "query") } : {}),
          ...(optionalString(args, "nameContains") ? { nameContains: optionalString(args, "nameContains") } : {}),
          ...(optionalString(args, "mimeType") ? { mimeType: optionalString(args, "mimeType") } : {}),
          ...(optionalNumber(args, "maxResults") !== undefined
            ? { maxResults: optionalNumber(args, "maxResults") }
            : {}),
        }),
    },
    {
      name: "drive_read_file",
      description: "Read Google Drive file metadata and textual content when supported. Google Docs export as text and Sheets as CSV.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { fileId: { type: "string", description: "Google Drive file ID" } },
        required: ["fileId"],
        additionalProperties: false,
      },
      execute: async (args) => client.driveReadFile(requiredString(args, "fileId")),
    },
    {
      name: "drive_create_text_file",
      description: "Create a text-based file in Google Drive. This changes external Drive state and requires approval by default.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "File name" },
          content: { type: "string", description: "UTF-8 text content" },
          mimeType: { type: "string", description: "MIME type, defaults to text/plain" },
          parentId: { type: "string", description: "Optional parent folder ID" },
        },
        required: ["name", "content"],
        additionalProperties: false,
      },
      execute: async (args) =>
        client.driveCreateTextFile({
          name: requiredString(args, "name"),
          content: requiredString(args, "content"),
          ...(optionalString(args, "mimeType") ? { mimeType: optionalString(args, "mimeType") } : {}),
          ...(optionalString(args, "parentId") ? { parentId: optionalString(args, "parentId") } : {}),
        }),
    },
    {
      name: "drive_move_file",
      description: "Move a Google Drive file to another folder, optionally removing it from previous parent folders. Requires approval by default.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "Google Drive file ID" },
          newParentId: { type: "string", description: "Destination folder ID" },
          removeParentIds: { type: "array", items: { type: "string" }, description: "Optional old parent IDs to remove" },
        },
        required: ["fileId", "newParentId"],
        additionalProperties: false,
      },
      execute: async (args) =>
        client.driveMoveFile(
          requiredString(args, "fileId"),
          requiredString(args, "newParentId"),
          optionalStringArray(args, "removeParentIds") ?? [],
        ),
    },
    {
      name: "docs_create",
      description: "Create a new Google Doc, optionally with initial body text. This creates external Drive state and requires approval by default.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Document title" },
          initialText: { type: "string", description: "Optional text to insert into the new document" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      execute: async (args) =>
        client.docsCreate(requiredString(args, "title"), optionalString(args, "initialText")),
    },
    {
      name: "docs_read",
      description: "Read a Google Doc's title and plain-text body content by document ID.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { documentId: { type: "string", description: "Google Docs document ID" } },
        required: ["documentId"],
        additionalProperties: false,
      },
      execute: async (args) => client.docsRead(requiredString(args, "documentId")),
    },
    {
      name: "docs_append_text",
      description: "Append plain text to the end of an existing Google Doc. Requires approval by default.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          documentId: { type: "string", description: "Google Docs document ID" },
          text: { type: "string", description: "Text to append at the end of the document" },
        },
        required: ["documentId", "text"],
        additionalProperties: false,
      },
      execute: async (args) =>
        client.docsAppendText(requiredString(args, "documentId"), requiredString(args, "text")),
    },
    {
      name: "sheets_create",
      description: "Create a new Google Sheets spreadsheet. This creates external Drive state and requires approval by default.",
      risk: "external",
      parameters: {
        type: "object",
        properties: { title: { type: "string", description: "Spreadsheet title" } },
        required: ["title"],
        additionalProperties: false,
      },
      execute: async (args) => client.sheetsCreate(requiredString(args, "title")),
    },
    {
      name: "sheets_read",
      description: "Read cell values from a Google Sheets range, for example Sheet1!A1:D20. Defaults to A1:Z1000 on the first sheet.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          spreadsheetId: { type: "string", description: "Google Sheets spreadsheet ID" },
          range: { type: "string", description: "A1 notation range, optionally including a sheet name" },
        },
        required: ["spreadsheetId"],
        additionalProperties: false,
      },
      execute: async (args) =>
        client.sheetsRead(requiredString(args, "spreadsheetId"), optionalString(args, "range")),
    },
    {
      name: "sheets_update_range",
      description: "Overwrite cell values in a Google Sheets range, including formulas such as =SUM(A1:A5). Requires approval by default.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          spreadsheetId: { type: "string", description: "Google Sheets spreadsheet ID" },
          range: { type: "string", description: "A1 notation range to overwrite, for example Sheet1!A1:B2" },
          values: {
            type: "array",
            items: { type: "array", items: {} },
            description: "Row-major 2D array of cell values or formulas",
          },
        },
        required: ["spreadsheetId", "range", "values"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const values = args.values;
        if (!Array.isArray(values) || !values.every((row) => Array.isArray(row))) {
          throw new Error("values must be a 2D array of rows");
        }
        return client.sheetsUpdateRange(
          requiredString(args, "spreadsheetId"),
          requiredString(args, "range"),
          values as unknown[][],
        );
      },
    },
    {
      name: "sheets_append_row",
      description: "Append one row of values after the last row of data in a Google Sheets range or sheet. Requires approval by default.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          spreadsheetId: { type: "string", description: "Google Sheets spreadsheet ID" },
          range: { type: "string", description: "Sheet name or A1 range identifying the table, for example Sheet1" },
          values: { type: "array", items: {}, description: "Cell values for the new row, in column order" },
        },
        required: ["spreadsheetId", "range", "values"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const values = args.values;
        if (!Array.isArray(values)) throw new Error("values must be an array");
        return client.sheetsAppendRow(
          requiredString(args, "spreadsheetId"),
          requiredString(args, "range"),
          values as unknown[],
        );
      },
    },
    {
      name: "slides_create",
      description: "Create a new Google Slides presentation. This creates external Drive state and requires approval by default.",
      risk: "external",
      parameters: {
        type: "object",
        properties: { title: { type: "string", description: "Presentation title" } },
        required: ["title"],
        additionalProperties: false,
      },
      execute: async (args) => client.slidesCreate(requiredString(args, "title")),
    },
    {
      name: "slides_read",
      description: "Read a Google Slides presentation's title and per-slide text content by presentation ID.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: { presentationId: { type: "string", description: "Google Slides presentation ID" } },
        required: ["presentationId"],
        additionalProperties: false,
      },
      execute: async (args) => client.slidesRead(requiredString(args, "presentationId")),
    },
    {
      name: "slides_append_slide",
      description: "Append a new title-and-body slide to the end of an existing Google Slides presentation. Requires approval by default.",
      risk: "external",
      parameters: {
        type: "object",
        properties: {
          presentationId: { type: "string", description: "Google Slides presentation ID" },
          title: { type: "string", description: "New slide title" },
          body: { type: "string", description: "Optional new slide body text" },
        },
        required: ["presentationId", "title"],
        additionalProperties: false,
      },
      execute: async (args) =>
        client.slidesAppendSlide(
          requiredString(args, "presentationId"),
          requiredString(args, "title"),
          optionalString(args, "body"),
        ),
    },
  ];
}
