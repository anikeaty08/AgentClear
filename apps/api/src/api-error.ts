export class ApiError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

