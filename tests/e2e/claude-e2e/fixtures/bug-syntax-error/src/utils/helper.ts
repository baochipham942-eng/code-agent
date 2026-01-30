export function calculateSum(numbers: number[]): number {
  let sum = 0;
  for (const num of numbers) {
    sum += num
  }
  return sum
}

// Syntax error: missing closing brace
export function greet(name: string): string {
  if (name) {
    return `Hello, ${name}!`;
  // Missing closing brace here
  return "Hello!";
}
