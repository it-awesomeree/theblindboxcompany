import { DEMO_ADMIN_ID, DEMO_CUSTOMER_ID } from '../domain/constants'
import { assert, assertRole, isoNow, makeId, sanitizeText, validateDemoEmail } from '../domain/guards'
import type { User } from '../domain/types'
import type { MockRepository } from '../data/MockRepository'
import { AuditService } from './AuditService'

export class MockAuthGateway {
  constructor(private readonly repository: MockRepository, private readonly audit: AuditService) {}

  oneClick(kind: 'customer' | 'admin') {
    const userId = kind === 'admin' ? DEMO_ADMIN_ID : DEMO_CUSTOMER_ID
    return this.repository.update((state) => {
      const user = state.users.find((entry) => entry.id === userId)
      assertRole(user, [kind === 'admin' ? 'super_admin' : 'customer'], 'sign in')
      state.sessionUserId = userId
      return user
    })
  }

  mockGoogle() {
    return this.oneClick('customer')
  }

  emailAccess(rawEmail: string, rawName?: string) {
    const email = validateDemoEmail(rawEmail)
    return this.repository.update((state) => {
      let user = state.users.find((entry) => entry.email === email)
      if (!user) {
        const now = isoNow()
        user = {
          id: makeId('usr', email),
          name: sanitizeText(rawName || 'Demo Customer', 70),
          email,
          role: 'customer',
          status: 'active',
          createdAt: now,
        }
        assert(user.name, 'A fictional display name is required.', 'INVALID_NAME')
        state.users.push(user)
        this.audit.append(state, {
          actorId: user.id,
          actorRole: 'customer',
          action: 'auth.fake_email_created',
          targetType: 'user',
          targetId: user.id,
          reason: 'Password-free fictional demo access',
          at: now,
          requestId: makeId('req', `${email}:${now}`),
          after: { email: user.email, role: user.role },
        })
      }
      assert(user.status === 'active', 'This fictional user is suspended.', 'USER_SUSPENDED')
      state.sessionUserId = user.id
      return user
    })
  }

  logout() {
    this.repository.update((state) => {
      state.sessionUserId = null
    })
  }

  currentUser(): User | undefined {
    const state = this.repository.getSnapshot()
    return state.users.find((user) => user.id === state.sessionUserId)
  }
}
