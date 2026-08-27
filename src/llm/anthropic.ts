// Minimal Anthropic Messages API client.
// Deliberately uses fetch directly rather than pulling in the Anthropic SDK:
// discovery is the only path that needs an LLM; replay has no model dependency.

export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | TextBlock[];
  is_error?: boolean;
};

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type Message = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

export type Tool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

export type MessageRequest = {
  system?: string;
  messages: Message[];
  tools?: Tool[];
  maxTokens?: number;
};

export type MessageResponse = {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
};

export class AnthropicClient {
  private apiKey: string;
  readonly model: string;

  constructor(apiKey: string, model = "claude-sonnet-4-6") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async message(req: MessageRequest): Promise<MessageResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? 1024,
      messages: req.messages,
    };

    if (req.system) body.system = req.system;
    if (req.tools?.length) body.tools = req.tools;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(
        `Anthropic API error ${res.status}: ${text.slice(0, 1000)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Anthropic API returned invalid JSON");
    }

    const msg = parsed as Partial<MessageResponse>;

    if (!Array.isArray(msg.content)) {
      throw new Error("Anthropic API response missing content");
    }

    return msg as MessageResponse;
  }
}