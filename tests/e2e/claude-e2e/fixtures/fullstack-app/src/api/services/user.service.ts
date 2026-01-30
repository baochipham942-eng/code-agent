interface User {
  id: number;
  email: string;
  name?: string;
}

export class UserService {
  private users: User[] = [];
  private nextId = 1;

  async findAll(): Promise<User[]> {
    return this.users;
  }

  async findById(id: number): Promise<User | undefined> {
    return this.users.find((u) => u.id === id);
  }

  async create(data: { email: string; name?: string }): Promise<User> {
    const user: User = {
      id: this.nextId++,
      email: data.email,
      name: data.name,
    };
    this.users.push(user);
    return user;
  }
}
