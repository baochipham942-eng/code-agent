export function formatDate(date: Date): string {
  return date.toISOString();
}

// Type error: argument type mismatch
const result = formatDate("2024-01-01");
