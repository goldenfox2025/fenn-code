/** Helpers every tool family uses to declare and read its arguments. */

/** A required text argument, trimmed; empty ones are refused with a message the agent can act on. */
export const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${name} 不能为空`)
  return v.trim()
}

// Extra properties are allowed: coerceArgs maps them, and strict schemas make weaker models fail calls.
export function obj(properties: Record<string, unknown>, required: string[]) {
  return { type: 'object', properties, required }
}
