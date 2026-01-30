export interface AuthContext {
  userId?: number;
  isAuthenticated: boolean;
}

export function authenticate(token?: string): AuthContext {
  if (!token) {
    return { isAuthenticated: false };
  }

  // 简化的 token 验证
  try {
    const userId = parseInt(token.split('-')[1]);
    return { userId, isAuthenticated: true };
  } catch {
    return { isAuthenticated: false };
  }
}
