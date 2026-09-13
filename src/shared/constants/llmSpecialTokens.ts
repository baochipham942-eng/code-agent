/**
 * Model-specific control token literals.
 *
 * Unique source for stripping before untrusted content reaches the model.
 * Do not duplicate these strings in business code.
 *
 * Replacement (not deletion) is applied at the sanitizer seam so adjacent
 * text cannot be concatenated into a new instruction.
 */
export const LLM_SPECIAL_TOKEN_PLACEHOLDER = '[llm-special-token]';

/**
 * Mainstream chat/control tokens across ChatML, Llama, Gemma/Gemini, and
 * Qwen-style role headers. Intentionally excludes HTML-like `<s>`/`</s>`
 * which would false-positive on markup.
 */
export const LLM_SPECIAL_TOKEN_LITERALS = [
  '<|im_start|>',
  '<|im_end|>',
  '<|endoftext|>',
  '<|startoftext|>',
  '<|fim_prefix|>',
  '<|fim_middle|>',
  '<|fim_suffix|>',
  '<|endofprompt|>',
  '<|system|>',
  '<|user|>',
  '<|assistant|>',
  '<|end|>',
  '<<SYS>>',
  '<</SYS>>',
  '[INST]',
  '[/INST]',
  '<start_of_turn>',
  '<end_of_turn>',
] as const;

/**
 * Subset whose presence is a role-delimiter injection (same bar as the
 * historical `[INST]` / `<|im_start|>system` detector). Other literals are
 * stripped without a critical warning so a page merely mentioning
 * `<|endoftext|>` is not blocked.
 */
export const LLM_ROLE_DELIMITER_TOKENS = [
  '<|im_start|>',
  '<|system|>',
  '<|user|>',
  '<|assistant|>',
  '[INST]',
  '[/INST]',
  '<<SYS>>',
  '<</SYS>>',
  '<start_of_turn>',
  '<end_of_turn>',
] as const;
