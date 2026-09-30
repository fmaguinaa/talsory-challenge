import type { User, UserDirectory } from '../../domain/types';

/**
 * In-memory user directory (ADR-006).
 *
 * Users are seeded from the environment at startup rather than stored. The
 * challenge is a demonstration system, and a database would add a sixth service,
 * a migration story and a backup policy for one seeded user. The interface is
 * narrow enough that swapping this for a real directory later touches only this
 * file.
 */
export class InMemoryUserDirectory implements UserDirectory {
  private readonly users: ReadonlyMap<string, User>;

  /**
   * @param users the seeded users
   * @throws Error when two users share a username, which would otherwise make
   *   login depend on insertion order
   */
  constructor(users: readonly User[]) {
    const map = new Map<string, User>();
    for (const user of users) {
      if (map.has(user.username)) {
        throw new Error(`duplicate user in the seed list: ${user.username}`);
      }
      map.set(user.username, user);
    }
    this.users = map;
  }

  /**
   * Returns the user, or `undefined` when the username is unknown.
   *
   * The return is wrapped in a resolved promise rather than being awaited: a
   * real directory would do I/O, and the port is asynchronous either way. The
   * use case must therefore never assume this call is instantaneous, which is
   * exactly why the user-enumeration defence lives there (it still runs a
   * password verification) rather than here.
   */
  findByUsername(username: string): Promise<User | undefined> {
    return Promise.resolve(this.users.get(username));
  }
}
