export {};

declare global {
  interface ModelContextToolResult {
    content: { type: "text"; text: string }[];
    isError?: boolean;
  }

  interface ModelContextTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (
      input: Record<string, unknown>,
    ) => Promise<ModelContextToolResult> | ModelContextToolResult;
    annotations?: Record<string, unknown>;
  }

  interface ModelContext {
    registerTool?(
      tool: ModelContextTool,
      options?: { signal?: AbortSignal },
    ): Promise<unknown> | unknown;
    provideContext?(context: { tools: ModelContextTool[] }): Promise<void> | void;
  }

  interface Navigator {
    modelContext?: ModelContext;
  }

  interface Document {
    modelContext?: ModelContext;
  }
}
