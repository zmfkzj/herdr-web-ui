### Fixed
- Pi tool calls whose ids providers give with a `|` (OpenAI Responses, Codex, Copilot:
  `call_…|fc_…`) or other punctuation no longer show blank images in the terminal, missing images in
  the chat, or a whole-output link that finds nothing. Pi's tool call ids are now taken whole and
  opaque (1–1024 printable ASCII characters) by the terminal markers, the image endpoint and the
  whole-output endpoint, here and on remote PCs once their bridge is updated.
