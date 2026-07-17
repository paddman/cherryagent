import { GoogleAuth } from "./GoogleAuth.js";

type GmailHeader = { name?: string; value?: string };
type GmailPart = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
};
type GmailMessage = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart & { headers?: GmailHeader[] };
};

type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
  size?: string;
  parents?: string[];
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
};

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeSubject(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function headerValue(message: GmailMessage, name: string): string | undefined {
  const header = message.payload?.headers?.find(
    (item) => item.name?.toLowerCase() === name.toLowerCase(),
  );
  return header?.value;
}

function extractText(part?: GmailPart): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return base64UrlDecode(part.body.data);

  for (const child of part.parts ?? []) {
    const text = extractText(child);
    if (text) return text;
  }

  if (part.mimeType === "text/html" && part.body?.data) {
    return base64UrlDecode(part.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  return part.body?.data ? base64UrlDecode(part.body.data) : "";
}

function messageSummary(message: GmailMessage): Record<string, unknown> {
  return {
    id: message.id,
    threadId: message.threadId,
    subject: headerValue(message, "Subject") ?? "(no subject)",
    from: headerValue(message, "From") ?? "",
    to: headerValue(message, "To") ?? "",
    date: headerValue(message, "Date") ?? "",
    snippet: message.snippet ?? "",
    labels: message.labelIds ?? [],
  };
}

function buildMimeMessage(input: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const lines = [
    `To: ${sanitizeHeader(input.to)}`,
    ...(input.cc ? [`Cc: ${sanitizeHeader(input.cc)}`] : []),
    ...(input.bcc ? [`Bcc: ${sanitizeHeader(input.bcc)}`] : []),
    `Subject: ${encodeSubject(input.subject)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${sanitizeHeader(input.inReplyTo)}`] : []),
    ...(input.references ? [`References: ${sanitizeHeader(input.references)}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    input.body,
  ];
  return base64UrlEncode(lines.join("\r\n"));
}

function escapeDriveLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

type DocsParagraphElement = { textRun?: { content?: string } };
type DocsStructuralElement = {
  paragraph?: { elements?: DocsParagraphElement[] };
  table?: { tableRows?: Array<{ tableCells?: Array<{ content?: DocsStructuralElement[] }> }> };
};
type DocsDocument = {
  documentId?: string;
  title?: string;
  revisionId?: string;
  body?: { content?: DocsStructuralElement[] };
};

function extractDocsText(elements: DocsStructuralElement[] | undefined): string {
  if (!elements) return "";
  let text = "";
  for (const element of elements) {
    if (element.paragraph?.elements) {
      for (const run of element.paragraph.elements) {
        if (run.textRun?.content) text += run.textRun.content;
      }
    }
    if (element.table?.tableRows) {
      for (const row of element.table.tableRows) {
        for (const cell of row.tableCells ?? []) {
          text += extractDocsText(cell.content);
        }
      }
    }
  }
  return text;
}

type SheetsSpreadsheet = {
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  properties?: { title?: string };
  sheets?: Array<{ properties?: { title?: string; sheetId?: number } }>;
};

type SlidesSlide = {
  objectId?: string;
  pageElements?: Array<{
    shape?: { text?: { textElements?: Array<{ textRun?: { content?: string } }> } };
  }>;
};
type SlidesPresentation = {
  presentationId?: string;
  presentationUrl?: string;
  title?: string;
  slides?: SlidesSlide[];
};

function extractSlideText(slide: SlidesSlide | undefined): string {
  const runs: string[] = [];
  for (const element of slide?.pageElements ?? []) {
    for (const textElement of element.shape?.text?.textElements ?? []) {
      if (textElement.textRun?.content) runs.push(textElement.textRun.content);
    }
  }
  return runs.join("").trim();
}

export class GoogleWorkspaceClient {
  constructor(private readonly auth: GoogleAuth) {}

  isConfigured(): boolean {
    return this.auth.isConfigured();
  }

  private async requestJson<T>(url: string | URL, init: RequestInit = {}): Promise<T> {
    const response = await this.auth.authorizedFetch(url, init);
    const text = await response.text();
    let payload: unknown = {};
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const detail =
        typeof payload === "object" && payload !== null && "error" in payload
          ? JSON.stringify((payload as { error: unknown }).error)
          : String(payload || response.statusText);
      throw new Error(`Google API request failed (${response.status}): ${detail}`);
    }
    return payload as T;
  }

  private async requestText(url: string | URL, init: RequestInit = {}): Promise<string> {
    const response = await this.auth.authorizedFetch(url, init);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Google API request failed (${response.status}): ${text || response.statusText}`);
    }
    return text;
  }

  async gmailSearch(query: string, maxResults = 10): Promise<unknown> {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    if (query.trim()) url.searchParams.set("q", query.trim());
    url.searchParams.set("maxResults", String(Math.min(Math.max(maxResults, 1), 50)));

    const listing = await this.requestJson<{ messages?: Array<{ id?: string }> }>(url);
    const ids = (listing.messages ?? []).map((item) => item.id).filter((id): id is string => Boolean(id));
    const messages = await Promise.all(ids.map((id) => this.gmailGetMessage(id, "metadata")));
    return { query, count: messages.length, messages: messages.map(messageSummary), verified: true };
  }

  async gmailReadMessage(messageId: string): Promise<unknown> {
    const message = await this.gmailGetMessage(messageId, "full");
    const body = extractText(message.payload).slice(0, 50_000);
    return { ...messageSummary(message), body, verified: true };
  }

  private async gmailGetMessage(messageId: string, format: "metadata" | "full"): Promise<GmailMessage> {
    const url = new URL(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`,
    );
    url.searchParams.set("format", format);
    if (format === "metadata") {
      for (const header of ["Subject", "From", "To", "Date", "Message-ID"]) {
        url.searchParams.append("metadataHeaders", header);
      }
    }
    return this.requestJson<GmailMessage>(url);
  }

  async gmailCreateDraft(input: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
  }): Promise<unknown> {
    const raw = buildMimeMessage(input);
    const draft = await this.requestJson<{ id?: string; message?: { id?: string; threadId?: string } }>(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: { raw } }),
      },
    );
    return {
      ok: true,
      draftId: draft.id,
      messageId: draft.message?.id,
      threadId: draft.message?.threadId,
      verified: Boolean(draft.id),
    };
  }

  async gmailSendEmail(input: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
  }): Promise<unknown> {
    const raw = buildMimeMessage(input);
    const sent = await this.requestJson<{ id?: string; threadId?: string; labelIds?: string[] }>(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw }),
      },
    );
    return { ok: true, messageId: sent.id, threadId: sent.threadId, verified: Boolean(sent.id) };
  }

  async gmailReply(messageId: string, body: string): Promise<unknown> {
    const original = await this.gmailGetMessage(messageId, "full");
    const from = headerValue(original, "From");
    if (!from) throw new Error("Cannot reply because the original message has no From header");

    const originalSubject = headerValue(original, "Subject") ?? "";
    const subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
    const messageHeaderId = headerValue(original, "Message-ID");
    const raw = buildMimeMessage({
      to: from,
      subject,
      body,
      ...(messageHeaderId ? { inReplyTo: messageHeaderId, references: messageHeaderId } : {}),
    });

    const sent = await this.requestJson<{ id?: string; threadId?: string }>(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw, threadId: original.threadId }),
      },
    );
    return { ok: true, messageId: sent.id, threadId: sent.threadId, verified: Boolean(sent.id) };
  }

  async gmailArchive(messageId: string): Promise<unknown> {
    const result = await this.requestJson<{ id?: string; threadId?: string; labelIds?: string[] }>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ removeLabelIds: ["INBOX"] }),
      },
    );
    return { ok: true, messageId: result.id, labels: result.labelIds ?? [], verified: Boolean(result.id) };
  }

  async calendarListEvents(input: {
    timeMin?: string;
    timeMax?: string;
    query?: string;
    maxResults?: number;
  }): Promise<unknown> {
    const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", String(Math.min(Math.max(input.maxResults ?? 20, 1), 100)));
    if (input.timeMin) url.searchParams.set("timeMin", new Date(input.timeMin).toISOString());
    if (input.timeMax) url.searchParams.set("timeMax", new Date(input.timeMax).toISOString());
    if (input.query) url.searchParams.set("q", input.query);

    const result = await this.requestJson<{ items?: unknown[]; nextPageToken?: string }>(url);
    return { count: result.items?.length ?? 0, events: result.items ?? [], verified: true };
  }

  async calendarCreateEvent(input: {
    summary: string;
    start: string;
    end: string;
    timeZone?: string;
    description?: string;
    location?: string;
    attendees?: string[];
  }): Promise<unknown> {
    const event = {
      summary: input.summary,
      start: { dateTime: new Date(input.start).toISOString(), ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
      end: { dateTime: new Date(input.end).toISOString(), ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
      ...(input.description ? { description: input.description } : {}),
      ...(input.location ? { location: input.location } : {}),
      ...(input.attendees?.length ? { attendees: input.attendees.map((email) => ({ email })) } : {}),
    };

    const result = await this.requestJson<{ id?: string; htmlLink?: string; status?: string }>(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      },
    );
    return { ok: true, eventId: result.id, htmlLink: result.htmlLink, status: result.status, verified: Boolean(result.id) };
  }

  async calendarUpdateEvent(
    eventId: string,
    patch: {
      summary?: string;
      start?: string;
      end?: string;
      timeZone?: string;
      description?: string;
      location?: string;
    },
  ): Promise<unknown> {
    const body = {
      ...(patch.summary ? { summary: patch.summary } : {}),
      ...(patch.start
        ? { start: { dateTime: new Date(patch.start).toISOString(), ...(patch.timeZone ? { timeZone: patch.timeZone } : {}) } }
        : {}),
      ...(patch.end
        ? { end: { dateTime: new Date(patch.end).toISOString(), ...(patch.timeZone ? { timeZone: patch.timeZone } : {}) } }
        : {}),
      ...(patch.description ? { description: patch.description } : {}),
      ...(patch.location ? { location: patch.location } : {}),
    };

    if (Object.keys(body).length === 0) throw new Error("At least one calendar field must be changed");
    const result = await this.requestJson<{ id?: string; htmlLink?: string; updated?: string }>(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { ok: true, eventId: result.id, htmlLink: result.htmlLink, updated: result.updated, verified: Boolean(result.id) };
  }

  async calendarDeleteEvent(eventId: string): Promise<unknown> {
    const response = await this.auth.authorizedFetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      throw new Error(`Google Calendar delete failed (${response.status}): ${await response.text()}`);
    }
    return { ok: true, eventId, deleted: true, verified: response.status === 204 || response.ok };
  }

  async driveSearchFiles(input: {
    query?: string;
    nameContains?: string;
    mimeType?: string;
    maxResults?: number;
  }): Promise<unknown> {
    const clauses: string[] = ["trashed = false"];
    if (input.query?.trim()) clauses.push(`(${input.query.trim()})`);
    if (input.nameContains?.trim()) clauses.push(`name contains '${escapeDriveLiteral(input.nameContains.trim())}'`);
    if (input.mimeType?.trim()) clauses.push(`mimeType = '${escapeDriveLiteral(input.mimeType.trim())}'`);

    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", clauses.join(" and "));
    url.searchParams.set("pageSize", String(Math.min(Math.max(input.maxResults ?? 20, 1), 100)));
    url.searchParams.set(
      "fields",
      "files(id,name,mimeType,modifiedTime,webViewLink,size,parents,owners(displayName,emailAddress)),nextPageToken",
    );
    url.searchParams.set("orderBy", "modifiedTime desc");

    const result = await this.requestJson<{ files?: DriveFile[]; nextPageToken?: string }>(url);
    return { count: result.files?.length ?? 0, files: result.files ?? [], verified: true };
  }

  async driveReadFile(fileId: string): Promise<unknown> {
    const fields = "id,name,mimeType,modifiedTime,webViewLink,size,parents,owners(displayName,emailAddress)";
    const metadata = await this.requestJson<DriveFile>(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}`,
    );
    const mimeType = metadata.mimeType ?? "";
    let content: string | undefined;

    if (mimeType === "application/vnd.google-apps.document") {
      content = await this.requestText(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent("text/plain")}`,
      );
    } else if (mimeType === "application/vnd.google-apps.spreadsheet") {
      content = await this.requestText(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent("text/csv")}`,
      );
    } else if (
      mimeType.startsWith("text/") ||
      ["application/json", "application/xml", "application/javascript"].includes(mimeType)
    ) {
      content = await this.requestText(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      );
    }

    return {
      metadata,
      ...(content !== undefined ? { content: content.slice(0, 100_000), truncated: content.length > 100_000 } : {}),
      verified: Boolean(metadata.id),
    };
  }

  async driveCreateTextFile(input: {
    name: string;
    content: string;
    mimeType?: string;
    parentId?: string;
  }): Promise<unknown> {
    const boundary = `cherry_${crypto.randomUUID().replace(/-/g, "")}`;
    const metadata = {
      name: input.name,
      mimeType: input.mimeType ?? "text/plain",
      ...(input.parentId ? { parents: [input.parentId] } : {}),
    };
    const body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(metadata),
      `--${boundary}`,
      `Content-Type: ${input.mimeType ?? "text/plain"}; charset=UTF-8`,
      "",
      input.content,
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const result = await this.requestJson<DriveFile>(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,webViewLink,parents",
      {
        method: "POST",
        headers: { "content-type": `multipart/related; boundary=${boundary}` },
        body,
      },
    );
    return { ok: true, file: result, verified: Boolean(result.id) };
  }

  async driveMoveFile(fileId: string, newParentId: string, removeParentIds: string[] = []): Promise<unknown> {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set("addParents", newParentId);
    if (removeParentIds.length) url.searchParams.set("removeParents", removeParentIds.join(","));
    url.searchParams.set("fields", "id,name,mimeType,modifiedTime,webViewLink,parents");

    const result = await this.requestJson<DriveFile>(url, { method: "PATCH" });
    return { ok: true, file: result, verified: Boolean(result.id) };
  }

  async docsCreate(title: string, initialText?: string): Promise<unknown> {
    const doc = await this.requestJson<DocsDocument>("https://docs.googleapis.com/v1/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!doc.documentId) throw new Error("Google Docs did not return a document ID");

    if (initialText) {
      await this.requestJson(
        `https://docs.googleapis.com/v1/documents/${encodeURIComponent(doc.documentId)}:batchUpdate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requests: [{ insertText: { endOfSegmentLocation: {}, text: initialText } }],
          }),
        },
      );
    }

    return {
      ok: true,
      documentId: doc.documentId,
      title: doc.title,
      url: `https://docs.google.com/document/d/${doc.documentId}/edit`,
      verified: Boolean(doc.documentId),
    };
  }

  async docsRead(documentId: string): Promise<unknown> {
    const doc = await this.requestJson<DocsDocument>(
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`,
    );
    const content = extractDocsText(doc.body?.content).slice(0, 100_000);
    return {
      documentId: doc.documentId,
      title: doc.title,
      revisionId: doc.revisionId,
      content,
      verified: Boolean(doc.documentId),
    };
  }

  async docsAppendText(documentId: string, text: string): Promise<unknown> {
    const result = await this.requestJson<{ documentId?: string }>(
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: [{ insertText: { endOfSegmentLocation: {}, text } }],
        }),
      },
    );
    return { ok: true, documentId: result.documentId ?? documentId, verified: Boolean(result.documentId) };
  }

  async sheetsCreate(title: string): Promise<unknown> {
    const sheet = await this.requestJson<SheetsSpreadsheet>("https://sheets.googleapis.com/v4/spreadsheets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ properties: { title } }),
    });
    return {
      ok: true,
      spreadsheetId: sheet.spreadsheetId,
      title: sheet.properties?.title,
      url: sheet.spreadsheetUrl,
      verified: Boolean(sheet.spreadsheetId),
    };
  }

  async sheetsRead(spreadsheetId: string, range = "A1:Z1000"): Promise<unknown> {
    const result = await this.requestJson<{ range?: string; values?: unknown[][] }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
    );
    return { range: result.range ?? range, values: result.values ?? [], verified: true };
  }

  async sheetsUpdateRange(spreadsheetId: string, range: string, values: unknown[][]): Promise<unknown> {
    const result = await this.requestJson<{ updatedRange?: string; updatedCells?: number }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values }),
      },
    );
    return {
      ok: true,
      updatedRange: result.updatedRange,
      updatedCells: result.updatedCells,
      verified: Boolean(result.updatedRange),
    };
  }

  async sheetsAppendRow(spreadsheetId: string, range: string, values: unknown[]): Promise<unknown> {
    const result = await this.requestJson<{
      updates?: { updatedRange?: string; updatedCells?: number };
    }>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: [values] }),
      },
    );
    return {
      ok: true,
      updatedRange: result.updates?.updatedRange,
      updatedCells: result.updates?.updatedCells,
      verified: Boolean(result.updates?.updatedRange),
    };
  }

  async slidesCreate(title: string): Promise<unknown> {
    const presentation = await this.requestJson<SlidesPresentation>(
      "https://slides.googleapis.com/v1/presentations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      },
    );
    return {
      ok: true,
      presentationId: presentation.presentationId,
      title: presentation.title,
      url: `https://docs.google.com/presentation/d/${presentation.presentationId}/edit`,
      verified: Boolean(presentation.presentationId),
    };
  }

  async slidesRead(presentationId: string): Promise<unknown> {
    const presentation = await this.requestJson<SlidesPresentation>(
      `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}`,
    );
    const slides = (presentation.slides ?? []).map((slide, index) => ({
      index,
      objectId: slide.objectId,
      text: extractSlideText(slide),
    }));
    return {
      presentationId: presentation.presentationId,
      title: presentation.title,
      slideCount: slides.length,
      slides,
      verified: Boolean(presentation.presentationId),
    };
  }

  async slidesAppendSlide(presentationId: string, title: string, body?: string): Promise<unknown> {
    const presentation = await this.requestJson<SlidesPresentation>(
      `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}`,
    );
    const insertionIndex = presentation.slides?.length ?? 0;
    const slideId = `cherry_${crypto.randomUUID().replace(/-/g, "")}`;
    const titleId = `${slideId}_title`;
    const bodyId = `${slideId}_body`;

    const requests: unknown[] = [
      {
        createSlide: {
          objectId: slideId,
          insertionIndex,
          slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
          placeholderIdMappings: [
            { layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: titleId },
            { layoutPlaceholder: { type: "BODY", index: 0 }, objectId: bodyId },
          ],
        },
      },
      { insertText: { objectId: titleId, text: title } },
      ...(body ? [{ insertText: { objectId: bodyId, text: body } }] : []),
    ];

    const result = await this.requestJson<{ presentationId?: string }>(
      `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}:batchUpdate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requests }),
      },
    );
    return {
      ok: true,
      presentationId: result.presentationId ?? presentationId,
      slideId,
      insertionIndex,
      verified: Boolean(result.presentationId),
    };
  }
}
