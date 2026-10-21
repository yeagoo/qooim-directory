/** Built-in source modules. This describes reviewed code shipped with the application. */
export const moduleIds = ["directory", "opensource"] as const;
export const moduleManifest = [
  {
    id: "directory",
    apiVersion: 1,
    name: "通用导航",
    dependsOn: [],
    publicEntry: "catalog",
    adminEntry: "content",
    jobs: [],
    resourceKinds: ["website"],
  },
  {
    id: "opensource",
    apiVersion: 1,
    name: "开源项目",
    dependsOn: ["directory"],
    publicEntry: "catalog",
    adminEntry: "github",
    jobs: ["github-repository"],
    resourceKinds: ["repository"],
  },
] as const;
