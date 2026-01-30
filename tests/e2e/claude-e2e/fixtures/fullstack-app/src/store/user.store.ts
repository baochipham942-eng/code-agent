interface User {
  id: number;
  email: string;
  name?: string;
}

interface UserStore {
  users: User[];
  loading: boolean;
  fetchUsers: () => Promise<void>;
}

// 简化的 store 实现
let state: UserStore = {
  users: [],
  loading: false,
  fetchUsers: async () => {
    state.loading = true;
    // 模拟 API 调用
    await new Promise((r) => setTimeout(r, 100));
    state.users = [
      { id: 1, email: 'test@test.com', name: 'Test User' },
    ];
    state.loading = false;
  },
};

export function useUserStore(): UserStore {
  return state;
}
