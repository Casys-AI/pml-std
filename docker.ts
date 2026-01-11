/**
 * Docker tools - container and image management
 *
 * @module lib/std/tools/docker
 */

import { type MiniTool, runCommand } from "./common.ts";

export const dockerTools: MiniTool[] = [
  {
    name: "docker_ps",
    description:
      "List running Docker containers. Shows container status, ports, names, images, and resource usage. Use to check what services are running, debug deployment issues, monitor container health, or find container IDs for other operations. Keywords: docker ps, container list, running services, container status.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Show all containers (default: only running)" },
        format: { type: "string", description: "Output format (json, table)" },
      },
    },
    handler: async ({ all = false, format = "json" }) => {
      const args = ["ps"];
      if (all) args.push("-a");
      if (format === "json") args.push("--format", "{{json .}}");

      const result = await runCommand("docker", args);
      if (result.code !== 0) {
        throw new Error(`docker ps failed: ${result.stderr}`);
      }

      if (format === "json") {
        const lines = result.stdout.trim().split("\n").filter(Boolean);
        const containers = lines.map((line) => JSON.parse(line));
        return { containers, count: containers.length };
      }
      return result.stdout;
    },
  },
  {
    name: "docker_images",
    description:
      "List available Docker images on the system. Shows image repository, tags, sizes, and creation dates. Use to check available images before running containers, find unused images for cleanup, or verify image pulls. Keywords: docker images, image list, repository tags, container images.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Show all images including intermediates" },
        format: { type: "string", description: "Output format (json, table)" },
      },
    },
    handler: async ({ all = false, format = "json" }) => {
      const args = ["images"];
      if (all) args.push("-a");
      if (format === "json") args.push("--format", "{{json .}}");

      const result = await runCommand("docker", args);
      if (result.code !== 0) {
        throw new Error(`docker images failed: ${result.stderr}`);
      }

      if (format === "json") {
        const lines = result.stdout.trim().split("\n").filter(Boolean);
        const images = lines.map((line) => JSON.parse(line));
        return { images, count: images.length };
      }
      return result.stdout;
    },
  },
  {
    name: "docker_logs",
    description:
      "Fetch logs from a Docker container for debugging and monitoring. Retrieve stdout/stderr output, filter by time range, or tail recent lines. Essential for troubleshooting container issues, viewing application output, debugging crashes, and monitoring service behavior. Keywords: container logs, debug output, stderr stdout, application logs.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        container: { type: "string", description: "Container ID or name" },
        tail: { type: "number", description: "Number of lines to show from end (default: 100)" },
        since: { type: "string", description: "Show logs since timestamp (e.g., '10m', '1h')" },
      },
      required: ["container"],
    },
    handler: async ({ container, tail = 100, since }) => {
      const args = ["logs", "--tail", String(tail)];
      if (since) args.push("--since", since as string);
      args.push(container as string);

      const result = await runCommand("docker", args);
      if (result.code !== 0) {
        throw new Error(`docker logs failed: ${result.stderr}`);
      }
      return { logs: result.stdout, stderr: result.stderr };
    },
  },
  {
    name: "docker_compose_ps",
    description:
      "List services defined in Docker Compose stack. Shows service status, ports, and health for multi-container applications. Use to monitor docker-compose deployments, check which services are running, verify orchestrated application state. Keywords: compose services, multi-container, stack status, docker-compose.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Compose file path (default: docker-compose.yml)" },
        cwd: { type: "string", description: "Working directory" },
      },
    },
    handler: async ({ file, cwd }) => {
      const args = ["compose"];
      if (file) args.push("-f", file as string);
      args.push("ps", "--format", "json");

      const result = await runCommand("docker", args, { cwd: cwd as string });
      if (result.code !== 0) {
        throw new Error(`docker compose ps failed: ${result.stderr}`);
      }

      try {
        const services = JSON.parse(result.stdout);
        return { services, count: services.length };
      } catch {
        return { output: result.stdout };
      }
    },
  },
  {
    name: "docker_stats",
    description:
      "Get real-time resource usage statistics for Docker containers. Shows CPU percentage, memory usage/limit, network I/O, and block I/O. Use for performance monitoring, identifying resource-hungry containers, capacity planning, and detecting memory leaks. Keywords: container metrics, CPU memory, resource usage, performance stats.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        container: {
          type: "string",
          description: "Container ID or name (optional, all if omitted)",
        },
      },
    },
    handler: async ({ container }) => {
      const args = ["stats", "--no-stream", "--format", "{{json .}}"];
      if (container) args.push(container as string);

      const result = await runCommand("docker", args);
      if (result.code !== 0) {
        throw new Error(`docker stats failed: ${result.stderr}`);
      }

      const lines = result.stdout.trim().split("\n").filter(Boolean);
      const stats = lines.map((line) => JSON.parse(line));
      return { stats, count: stats.length };
    },
  },
  {
    name: "docker_run",
    description:
      "Run a new Docker container from an image. Start containers with port mappings, volume mounts, environment variables, and resource limits. Use for deploying services, running tasks, testing images, or spinning up dev environments. Keywords: docker run, start container, deploy image, container create, port mapping, volume mount.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        image: { type: "string", description: "Image name and tag" },
        name: { type: "string", description: "Container name" },
        ports: {
          type: "array",
          items: { type: "string" },
          description: "Port mappings (e.g., ['8080:80', '443:443'])",
        },
        volumes: {
          type: "array",
          items: { type: "string" },
          description: "Volume mounts (e.g., ['/host:/container'])",
        },
        env: { type: "object", description: "Environment variables" },
        detach: { type: "boolean", description: "Run in background (default: true)" },
        rm: { type: "boolean", description: "Remove container when it exits" },
        network: { type: "string", description: "Network to connect to" },
        command: { type: "string", description: "Command to run in container" },
      },
      required: ["image"],
    },
    handler: async (
      { image, name, ports, volumes, env, detach = true, rm = false, network, command },
    ) => {
      const args = ["run"];
      if (detach) args.push("-d");
      if (rm) args.push("--rm");
      if (name) args.push("--name", name as string);
      if (network) args.push("--network", network as string);

      if (ports) {
        for (const p of ports as string[]) {
          args.push("-p", p);
        }
      }
      if (volumes) {
        for (const v of volumes as string[]) {
          args.push("-v", v);
        }
      }
      if (env) {
        for (const [key, value] of Object.entries(env as Record<string, string>)) {
          args.push("-e", `${key}=${value}`);
        }
      }

      args.push(image as string);
      if (command) args.push(...(command as string).split(" "));

      const result = await runCommand("docker", args);
      if (result.code !== 0) {
        throw new Error(`docker run failed: ${result.stderr}`);
      }
      return { containerId: result.stdout.trim(), detached: detach };
    },
  },
  {
    name: "docker_exec",
    description:
      "Execute a command inside a running Docker container. Run shell commands, scripts, or interactive sessions in containers. Essential for debugging, maintenance, inspecting container state, or running one-off tasks. Keywords: docker exec, container shell, run command, container bash, execute in container, container access.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        container: { type: "string", description: "Container ID or name" },
        command: { type: "string", description: "Command to execute" },
        workdir: { type: "string", description: "Working directory inside container" },
        user: { type: "string", description: "User to run as" },
        env: { type: "object", description: "Environment variables" },
      },
      required: ["container", "command"],
    },
    handler: async ({ container, command, workdir, user, env }) => {
      const args = ["exec"];
      if (workdir) args.push("-w", workdir as string);
      if (user) args.push("-u", user as string);
      if (env) {
        for (const [key, value] of Object.entries(env as Record<string, string>)) {
          args.push("-e", `${key}=${value}`);
        }
      }
      args.push(container as string);
      args.push("sh", "-c", command as string);

      const result = await runCommand("docker", args);
      if (result.code !== 0) {
        throw new Error(`docker exec failed: ${result.stderr}`);
      }
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
    },
  },
  {
    name: "docker_stop",
    description:
      "Stop one or more running Docker containers gracefully. Sends SIGTERM then SIGKILL after timeout. Use for shutting down services, restarting containers, or cleaning up. Keywords: docker stop, stop container, shutdown container, halt service, container terminate.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        containers: {
          type: "array",
          items: { type: "string" },
          description: "Container IDs or names",
        },
        timeout: { type: "number", description: "Seconds to wait before killing (default: 10)" },
      },
      required: ["containers"],
    },
    handler: async ({ containers, timeout = 10 }) => {
      const args = ["stop", "-t", String(timeout), ...(containers as string[])];

      const result = await runCommand("docker", args);
      if (result.code !== 0) {
        throw new Error(`docker stop failed: ${result.stderr}`);
      }
      return { stopped: result.stdout.trim().split("\n").filter(Boolean) };
    },
  },
  {
    name: "docker_rm",
    description:
      "Remove one or more Docker containers. Delete stopped containers to free resources. Use force option for running containers. Use for cleanup, removing old containers, or resetting state. Keywords: docker rm, remove container, delete container, container cleanup, container delete.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        containers: {
          type: "array",
          items: { type: "string" },
          description: "Container IDs or names",
        },
        force: { type: "boolean", description: "Force remove running containers" },
        volumes: { type: "boolean", description: "Remove associated volumes" },
      },
      required: ["containers"],
    },
    handler: async ({ containers, force = false, volumes = false }) => {
      const args = ["rm"];
      if (force) args.push("-f");
      if (volumes) args.push("-v");
      args.push(...(containers as string[]));

      const result = await runCommand("docker", args);
      if (result.code !== 0) {
        throw new Error(`docker rm failed: ${result.stderr}`);
      }
      return { removed: result.stdout.trim().split("\n").filter(Boolean) };
    },
  },
  {
    name: "docker_build",
    description:
      "Build a Docker image from a Dockerfile. Create custom images with build args, tags, and multi-stage builds. Use for CI/CD pipelines, creating deployable images, or packaging applications. Keywords: docker build, dockerfile, build image, create image, container build, image create.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Build context path (default: .)" },
        dockerfile: { type: "string", description: "Dockerfile path" },
        tag: { type: "string", description: "Image tag (e.g., 'myapp:latest')" },
        buildArgs: { type: "object", description: "Build arguments" },
        target: { type: "string", description: "Target build stage" },
        noCache: { type: "boolean", description: "Build without cache" },
      },
    },
    handler: async ({ path = ".", dockerfile, tag, buildArgs, target, noCache = false }) => {
      const args = ["build"];
      if (dockerfile) args.push("-f", dockerfile as string);
      if (tag) args.push("-t", tag as string);
      if (target) args.push("--target", target as string);
      if (noCache) args.push("--no-cache");
      if (buildArgs) {
        for (const [key, value] of Object.entries(buildArgs as Record<string, string>)) {
          args.push("--build-arg", `${key}=${value}`);
        }
      }
      args.push(path as string);

      const result = await runCommand("docker", args);
      if (result.code !== 0) {
        throw new Error(`docker build failed: ${result.stderr}`);
      }
      return { output: result.stdout, tag };
    },
  },
  {
    name: "docker_pull",
    description:
      "Pull a Docker image from a registry. Download images from Docker Hub, private registries, or cloud registries. Use for updating images, preparing deployments, or fetching base images. Keywords: docker pull, download image, fetch image, registry pull, image download.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        image: { type: "string", description: "Image name and tag (e.g., 'nginx:latest')" },
        platform: { type: "string", description: "Platform (e.g., 'linux/amd64')" },
      },
      required: ["image"],
    },
    handler: async ({ image, platform }) => {
      const args = ["pull"];
      if (platform) args.push("--platform", platform as string);
      args.push(image as string);

      const result = await runCommand("docker", args);
      if (result.code !== 0) {
        throw new Error(`docker pull failed: ${result.stderr}`);
      }
      return { output: result.stdout, image };
    },
  },
  {
    name: "docker_push",
    description:
      "Push a Docker image to a registry. Upload images to Docker Hub, private registries, or cloud registries. Use for publishing images, CI/CD deployments, or sharing images. Keywords: docker push, upload image, publish image, registry push, image upload.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        image: { type: "string", description: "Image name and tag" },
      },
      required: ["image"],
    },
    handler: async ({ image }) => {
      const result = await runCommand("docker", ["push", image as string]);
      if (result.code !== 0) {
        throw new Error(`docker push failed: ${result.stderr}`);
      }
      return { output: result.stdout, image };
    },
  },
  {
    name: "docker_inspect",
    description:
      "Get detailed information about Docker containers or images. Returns full JSON config including network settings, mounts, environment, and metadata. Use for debugging, auditing, or scripting. Keywords: docker inspect, container info, image info, container details, metadata, configuration.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Container or image ID/name" },
        type: {
          type: "string",
          enum: ["container", "image", "volume", "network"],
          description: "Object type",
        },
      },
      required: ["target"],
    },
    handler: async ({ target, type }) => {
      const args = ["inspect"];
      if (type) args.push("--type", type as string);
      args.push(target as string);

      const result = await runCommand("docker", args);
      if (result.code !== 0) {
        throw new Error(`docker inspect failed: ${result.stderr}`);
      }
      return { data: JSON.parse(result.stdout) };
    },
  },
  {
    name: "docker_network_ls",
    description:
      "List Docker networks. Shows network drivers, scopes, and connected containers. Use for debugging connectivity, managing network isolation, or viewing network topology. Keywords: docker network, list networks, network info, bridge network, container networking.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", description: "Output format (json, table)" },
      },
    },
    handler: async ({ format = "json" }) => {
      const args = ["network", "ls"];
      if (format === "json") args.push("--format", "{{json .}}");

      const result = await runCommand("docker", args);
      if (result.code !== 0) {
        throw new Error(`docker network ls failed: ${result.stderr}`);
      }

      if (format === "json") {
        const lines = result.stdout.trim().split("\n").filter(Boolean);
        const networks = lines.map((line) => JSON.parse(line));
        return { networks, count: networks.length };
      }
      return { output: result.stdout };
    },
  },
  {
    name: "docker_volume_ls",
    description:
      "List Docker volumes. Shows volume names, drivers, and mount points for persistent data storage. Use for managing data persistence, backup planning, or cleanup. Keywords: docker volume, list volumes, persistent storage, data volumes, volume info.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", description: "Output format (json, table)" },
      },
    },
    handler: async ({ format = "json" }) => {
      const args = ["volume", "ls"];
      if (format === "json") args.push("--format", "{{json .}}");

      const result = await runCommand("docker", args);
      if (result.code !== 0) {
        throw new Error(`docker volume ls failed: ${result.stderr}`);
      }

      if (format === "json") {
        const lines = result.stdout.trim().split("\n").filter(Boolean);
        const volumes = lines.map((line) => JSON.parse(line));
        return { volumes, count: volumes.length };
      }
      return { output: result.stdout };
    },
  },
  {
    name: "docker_compose_up",
    description:
      "Start Docker Compose services. Bring up all services defined in compose file, with optional build and detach. Use for starting multi-container applications, development environments, or microservices stacks. Keywords: docker-compose up, start services, compose start, stack deploy, multi-container.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Compose file path" },
        services: {
          type: "array",
          items: { type: "string" },
          description: "Specific services to start",
        },
        detach: { type: "boolean", description: "Run in background (default: true)" },
        build: { type: "boolean", description: "Build images before starting" },
        forceRecreate: { type: "boolean", description: "Recreate containers even if unchanged" },
        cwd: { type: "string", description: "Working directory" },
      },
    },
    handler: async (
      { file, services, detach = true, build = false, forceRecreate = false, cwd },
    ) => {
      const args = ["compose"];
      if (file) args.push("-f", file as string);
      args.push("up");
      if (detach) args.push("-d");
      if (build) args.push("--build");
      if (forceRecreate) args.push("--force-recreate");
      if (services) args.push(...(services as string[]));

      const result = await runCommand("docker", args, { cwd: cwd as string });
      if (result.code !== 0) {
        throw new Error(`docker compose up failed: ${result.stderr}`);
      }
      return { output: result.stdout, detached: detach };
    },
  },
  {
    name: "docker_compose_down",
    description:
      "Stop and remove Docker Compose services. Tear down containers, networks, and optionally volumes. Use for cleanup, resetting state, or stopping development environments. Keywords: docker-compose down, stop services, compose stop, stack teardown, cleanup.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Compose file path" },
        volumes: { type: "boolean", description: "Remove volumes" },
        removeOrphans: { type: "boolean", description: "Remove orphan containers" },
        cwd: { type: "string", description: "Working directory" },
      },
    },
    handler: async ({ file, volumes = false, removeOrphans = false, cwd }) => {
      const args = ["compose"];
      if (file) args.push("-f", file as string);
      args.push("down");
      if (volumes) args.push("-v");
      if (removeOrphans) args.push("--remove-orphans");

      const result = await runCommand("docker", args, { cwd: cwd as string });
      if (result.code !== 0) {
        throw new Error(`docker compose down failed: ${result.stderr}`);
      }
      return { output: result.stdout };
    },
  },
  {
    name: "docker_compose_logs",
    description:
      "View logs from Docker Compose services. Stream or tail logs from multiple containers at once. Use for debugging multi-container apps, monitoring service output, or troubleshooting. Keywords: compose logs, service logs, multi-container logs, docker-compose logs, stream logs.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Compose file path" },
        services: { type: "array", items: { type: "string" }, description: "Specific services" },
        tail: { type: "number", description: "Number of lines (default: 100)" },
        since: { type: "string", description: "Show logs since timestamp" },
        cwd: { type: "string", description: "Working directory" },
      },
    },
    handler: async ({ file, services, tail = 100, since, cwd }) => {
      const args = ["compose"];
      if (file) args.push("-f", file as string);
      args.push("logs", "--tail", String(tail));
      if (since) args.push("--since", since as string);
      if (services) args.push(...(services as string[]));

      const result = await runCommand("docker", args, { cwd: cwd as string });
      if (result.code !== 0) {
        throw new Error(`docker compose logs failed: ${result.stderr}`);
      }
      return { logs: result.stdout };
    },
  },
  {
    name: "docker_prune",
    description:
      "Remove unused Docker resources to free disk space. Clean up stopped containers, dangling images, unused networks and volumes. Use for maintenance, disk cleanup, or resetting Docker state. Keywords: docker prune, cleanup, disk space, remove unused, garbage collection, docker clean.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["all", "containers", "images", "volumes", "networks"],
          description: "What to prune (default: all)",
        },
        force: { type: "boolean", description: "Don't prompt for confirmation" },
        all: { type: "boolean", description: "Remove all unused images, not just dangling" },
      },
    },
    handler: async ({ type = "all", force = true, all = false }) => {
      let args: string[];

      if (type === "all") {
        args = ["system", "prune"];
        if (all) args.push("-a");
      } else {
        args = [type as string, "prune"];
        if (type === "images" && all) args.push("-a");
      }

      if (force) args.push("-f");

      const result = await runCommand("docker", args);
      if (result.code !== 0) {
        throw new Error(`docker prune failed: ${result.stderr}`);
      }
      return { output: result.stdout };
    },
  },
];
