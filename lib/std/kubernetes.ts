/**
 * Kubernetes tools - cluster management
 *
 * @module lib/std/tools/kubernetes
 */

import { type MiniTool, runCommand } from "./common.ts";

export const kubernetesTools: MiniTool[] = [
  {
    name: "kubectl_get",
    description:
      "List and retrieve Kubernetes resources (pods, services, deployments, configmaps, secrets, etc.). Query by name, namespace, or label selector. Get detailed resource status, configuration, and metadata. Use for cluster monitoring, debugging, or resource inspection. Keywords: kubectl get, kubernetes resources, list pods, get services, k8s objects, cluster state.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        resource: {
          type: "string",
          description: "Resource type (pods, services, deployments, etc.)",
        },
        name: { type: "string", description: "Resource name (optional)" },
        namespace: { type: "string", description: "Namespace" },
        output: {
          type: "string",
          enum: ["json", "yaml", "wide", "name"],
          description: "Output format",
        },
        selector: { type: "string", description: "Label selector" },
        allNamespaces: { type: "boolean", description: "All namespaces" },
      },
      required: ["resource"],
    },
    handler: async (
      { resource, name, namespace, output = "json", selector, allNamespaces = false },
    ) => {
      const args = ["get", resource as string];
      if (name) args.push(name as string);
      if (namespace) args.push("-n", namespace as string);
      if (allNamespaces) args.push("-A");
      if (selector) args.push("-l", selector as string);
      args.push("-o", output as string);

      const result = await runCommand("kubectl", args);
      if (result.code !== 0) {
        throw new Error(`kubectl get failed: ${result.stderr}`);
      }

      if (output === "json") {
        try {
          return JSON.parse(result.stdout);
        } catch {
          return { output: result.stdout };
        }
      }
      return { output: result.stdout };
    },
  },
  {
    name: "kubectl_apply",
    description:
      "Apply Kubernetes manifests to create or update resources. Deploy applications, services, configmaps from YAML/JSON files. Supports dry-run for validation. Use for deployments, infrastructure-as-code, GitOps workflows. Keywords: kubectl apply, deploy kubernetes, k8s manifest, create resource, update deployment, kubernetes yaml.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Manifest file path" },
        namespace: { type: "string", description: "Namespace" },
        dryRun: { type: "boolean", description: "Dry run (client or server)" },
      },
      required: ["file"],
    },
    handler: async ({ file, namespace, dryRun = false }) => {
      const args = ["apply", "-f", file as string];
      if (namespace) args.push("-n", namespace as string);
      if (dryRun) args.push("--dry-run=client");

      const result = await runCommand("kubectl", args);
      if (result.code !== 0) {
        throw new Error(`kubectl apply failed: ${result.stderr}`);
      }
      return { success: true, output: result.stdout };
    },
  },
  {
    name: "kubectl_logs",
    description:
      "Fetch logs from Kubernetes pods for debugging and monitoring. View container stdout/stderr, filter by time, tail recent lines, or stream live. Essential for troubleshooting pod issues, application debugging, and monitoring. Keywords: kubectl logs, pod logs, container output, k8s debugging, application logs, stream logs.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        pod: { type: "string", description: "Pod name" },
        namespace: { type: "string", description: "Namespace" },
        container: { type: "string", description: "Container name" },
        tail: { type: "number", description: "Lines to show from end" },
        since: { type: "string", description: "Show logs since (e.g., '1h', '10m')" },
        follow: { type: "boolean", description: "Follow logs (stream)" },
      },
      required: ["pod"],
    },
    handler: async ({ pod, namespace, container, tail, since, follow }) => {
      const args = ["logs", pod as string];
      if (namespace) args.push("-n", namespace as string);
      if (container) args.push("-c", container as string);
      if (tail) args.push("--tail", String(tail));
      if (since) args.push("--since", since as string);
      if (follow) args.push("-f");

      const result = await runCommand("kubectl", args, { timeout: 60000 });
      return { logs: result.stdout, stderr: result.stderr };
    },
  },
  {
    name: "kubectl_exec",
    description:
      "Execute commands inside running Kubernetes pods. Run shell commands, debug containers, inspect filesystem, or troubleshoot applications directly. Essential for container debugging and interactive troubleshooting. Keywords: kubectl exec, pod shell, container exec, run command in pod, k8s debugging, interactive container.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        pod: { type: "string", description: "Pod name" },
        command: { type: "string", description: "Command to execute" },
        namespace: { type: "string", description: "Namespace" },
        container: { type: "string", description: "Container name" },
      },
      required: ["pod", "command"],
    },
    handler: async ({ pod, command, namespace, container }) => {
      const args = ["exec", pod as string];
      if (namespace) args.push("-n", namespace as string);
      if (container) args.push("-c", container as string);
      args.push("--", "sh", "-c", command as string);

      const result = await runCommand("kubectl", args, { timeout: 60000 });
      return {
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  },
];
