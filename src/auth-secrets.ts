export interface AuthValueField {
  value: string;
}

export function takeAndClearAuthResponses(fields: AuthValueField[]): string[] {
  const responses = fields.map((field) => field.value);
  for (const field of fields) field.value = '';
  return responses;
}

export function clearAuthResponses(responses: string[]): void {
  responses.fill('');
}
