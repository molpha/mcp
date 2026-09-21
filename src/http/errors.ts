export class HttpInputError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
