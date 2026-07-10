export const ADMIN_CLAIM_CREDENTIAL = Symbol('ADMIN_CLAIM_CREDENTIAL');

export interface AdminClaimCredentialPort {
  isConfigured(): boolean;
  verify(candidate: string): boolean;
}
