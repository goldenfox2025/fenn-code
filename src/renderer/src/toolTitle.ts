/**
 * A title an agent wrote for the call in progress ("Running view_file") and never updated: once the
 * call is over (done, failed, or its reply ended) it reads as the tool's name.
 */
export function settledTitle(title: string, over: boolean): string {
  return over ? title.replace(/^(?:Running|Calling|Executing|Invoking)\s+(?=\S)/, '') : title
}
