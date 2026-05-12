export interface PRPayload {
  url: string;
  sha: string;
  title: string;
  description: string;
  diff: string;
  ciStatus: "success" | "failure" | "pending" | "none";
}
