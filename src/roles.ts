import { ROLES, type Role } from './types.js'

/** Position in the hierarchy; higher includes every lower role. */
export const ROLE_ORDER: Record<Role, number> = Object.fromEntries(ROLES.map((role, index) => [role, index])) as Record<Role, number>

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_ORDER[role] >= ROLE_ORDER[minimum]
}

export function canModerate(role: Role): boolean {
  return roleAtLeast(role, 'moderator')
}

export function isAdmin(role: Role): boolean {
  return role === 'admin'
}
