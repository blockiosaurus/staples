export class BrandKitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandKitError";
  }
}
