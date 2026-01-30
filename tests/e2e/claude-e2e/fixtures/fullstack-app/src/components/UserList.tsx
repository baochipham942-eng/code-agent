import React, { useEffect } from 'react';
import { useUserStore } from '../store/user.store.js';

export function UserList() {
  const { users, fetchUsers, loading } = useUserStore();

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  if (loading) return <div>Loading...</div>;

  return (
    <ul className="user-list">
      {users.map((user) => (
        <li key={user.id}>{user.name || user.email}</li>
      ))}
    </ul>
  );
}
