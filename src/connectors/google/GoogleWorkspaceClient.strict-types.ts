import "./GoogleWorkspaceClient.js";

declare module "./GoogleWorkspaceClient.js" {
  interface GoogleWorkspaceClient {
    gmailCreateDraft(input: {
      to: string;
      subject: string;
      body: string;
      cc?: string | undefined;
      bcc?: string | undefined;
    }): Promise<unknown>;

    gmailSendEmail(input: {
      to: string;
      subject: string;
      body: string;
      cc?: string | undefined;
      bcc?: string | undefined;
    }): Promise<unknown>;

    calendarListEvents(input: {
      timeMin?: string | undefined;
      timeMax?: string | undefined;
      query?: string | undefined;
      maxResults?: number | undefined;
    }): Promise<unknown>;

    calendarCreateEvent(input: {
      summary: string;
      start: string;
      end: string;
      timeZone?: string | undefined;
      description?: string | undefined;
      location?: string | undefined;
      attendees?: string[] | undefined;
    }): Promise<unknown>;

    calendarUpdateEvent(
      eventId: string,
      patch: {
        summary?: string | undefined;
        start?: string | undefined;
        end?: string | undefined;
        timeZone?: string | undefined;
        description?: string | undefined;
        location?: string | undefined;
      },
    ): Promise<unknown>;

    driveSearchFiles(input: {
      query?: string | undefined;
      nameContains?: string | undefined;
      mimeType?: string | undefined;
      maxResults?: number | undefined;
    }): Promise<unknown>;

    driveCreateTextFile(input: {
      name: string;
      content: string;
      mimeType?: string | undefined;
      parentId?: string | undefined;
    }): Promise<unknown>;
  }
}
