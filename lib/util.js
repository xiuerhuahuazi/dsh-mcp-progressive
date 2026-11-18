/** Normalize a thrown value into a message string. */
export function messageOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}
