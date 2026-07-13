export const HOME_TOKEN_GENERATOR = Symbol('HOME_TOKEN_GENERATOR');

export interface HomeTokenGeneratorPort {
  generate(): string;
}
