declare module "mammoth" {
  export type ExtractRawTextInput = { buffer: Buffer } | { path: string };
  export type ExtractRawTextResult = {
    value: string;
    messages: Array<{ type: string; message: string }>;
  };

  export function extractRawText(input: ExtractRawTextInput): Promise<ExtractRawTextResult>;
}
