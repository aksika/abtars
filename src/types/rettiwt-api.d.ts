declare module "rettiwt-api" {
  export class Rettiwt {
    user: { details(handle: string): Promise<any> };
    tweet: { details(id: string): Promise<any>; search(query: any, count?: number): Promise<any> };
  }
}
