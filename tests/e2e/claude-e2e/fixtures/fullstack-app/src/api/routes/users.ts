import { UserService } from '../services/user.service.js';

const userService = new UserService();

export async function getUsers() {
  return await userService.findAll();
}

export async function getUserById(id: number) {
  return await userService.findById(id);
}

export async function createUser(data: { email: string; name?: string }) {
  return await userService.create(data);
}
