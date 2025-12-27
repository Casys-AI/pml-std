/**
 * Cloud CLI tools - AWS, GCP
 *
 * @module lib/std/tools/cloud
 */

import { type MiniTool, runCommand } from "./common.ts";

export const cloudTools: MiniTool[] = [
  {
    name: "aws_cli",
    description:
      "Execute AWS CLI commands for cloud infrastructure management. Access S3, EC2, Lambda, RDS, IAM and all AWS services. List resources, manage instances, deploy infrastructure. Use for cloud automation, DevOps, or AWS administration. Keywords: aws cli, amazon web services, s3 bucket, ec2 instance, lambda function, cloud management, aws command.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "AWS service (s3, ec2, lambda, etc.)" },
        command: { type: "string", description: "Command to run" },
        args: { type: "array", items: { type: "string" }, description: "Additional arguments" },
        region: { type: "string", description: "AWS region" },
        profile: { type: "string", description: "AWS profile" },
      },
      required: ["service", "command"],
    },
    handler: async ({ service, command, args = [], region, profile }) => {
      const cmdArgs = [service as string, command as string, ...(args as string[])];
      if (region) cmdArgs.push("--region", region as string);
      if (profile) cmdArgs.push("--profile", profile as string);
      cmdArgs.push("--output", "json");

      const result = await runCommand("aws", cmdArgs);
      if (result.code !== 0) {
        throw new Error(`aws cli failed: ${result.stderr}`);
      }

      try {
        return JSON.parse(result.stdout);
      } catch {
        return { output: result.stdout };
      }
    },
  },
  {
    name: "gcloud_cli",
    description:
      "Execute Google Cloud CLI commands for GCP infrastructure management. Access Compute Engine, Cloud Storage, Cloud Functions, BigQuery and all GCP services. Use for cloud automation, DevOps workflows, or GCP administration. Keywords: gcloud cli, google cloud, gcp command, compute engine, cloud storage, cloud functions, gcp management.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "Command group (compute, storage, etc.)" },
        command: { type: "string", description: "Command to run" },
        args: { type: "array", items: { type: "string" }, description: "Additional arguments" },
        project: { type: "string", description: "GCP project" },
      },
      required: ["group", "command"],
    },
    handler: async ({ group, command, args = [], project }) => {
      const cmdArgs = [group as string, command as string, ...(args as string[]), "--format=json"];
      if (project) cmdArgs.push("--project", project as string);

      const result = await runCommand("gcloud", cmdArgs);
      if (result.code !== 0) {
        throw new Error(`gcloud failed: ${result.stderr}`);
      }

      try {
        return JSON.parse(result.stdout);
      } catch {
        return { output: result.stdout };
      }
    },
  },
  {
    name: "systemctl",
    description:
      "Manage Linux systemd services and units. Start, stop, restart, enable, disable services. Check service status, list running units, manage system daemons. Essential for Linux server administration and service management. Keywords: systemctl, systemd service, start stop restart, service status, enable disable, linux daemon, unit management.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "start", "stop", "restart", "enable", "disable", "list-units"],
          description: "Action",
        },
        service: { type: "string", description: "Service name (not required for list-units)" },
        type: { type: "string", description: "Unit type filter for list-units" },
      },
      required: ["action"],
    },
    handler: async ({ action, service, type }) => {
      const args = [action as string];
      if (service) args.push(service as string);
      if (action === "list-units" && type) args.push("--type", type as string);

      const result = await runCommand("systemctl", args);
      return {
        action,
        service,
        exitCode: result.code,
        output: result.stdout,
        stderr: result.stderr,
        success: result.code === 0,
      };
    },
  },
];
