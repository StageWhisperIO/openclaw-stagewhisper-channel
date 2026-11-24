export const SEARCH_TOOL = {
  type: "function",
  function: {
    name: "searchLibrary",
    description: "Search the user's calls.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

export const AI_SDK_REQUEST = {
  model: "openclaw",
  messages: [
    { role: "system", content: "Answer only from tool results." },
    { role: "user", content: "What does Sealand need now?" },
    {
      role: "assistant",
      content: "Let me look.",
      tool_calls: [
        { id: "call_abc", type: "function", function: { name: "searchLibrary", arguments: '{"query":"Sealand"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_abc", content: '{"results":[{"excerptId":"e1"}]}' },
  ],
  tools: [SEARCH_TOOL],
  tool_choice: "auto",
  stream: true,
};
