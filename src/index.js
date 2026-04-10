#!/usr/bin/env node

/**
 * IDEA Base MCP Server
 *
 * Provides Claude Code with tools to interact with IDEA Base project management.
 * Tools include: list_projects, list_tasks, get_task, create_task, update_task,
 * update_task_status, log_time, and listen for real-time events.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Configuration from environment
const API_BASE_URL = process.env.IDEA_BASE_API_URL || 'https://app.idea-base.us/api';
const API_KEY = process.env.IDEA_BASE_API_KEY;

if (!API_KEY) {
  console.error('Error: IDEA_BASE_API_KEY environment variable is required');
  process.exit(1);
}

// API helper function
async function apiRequest(endpoint, options = {}) {
  const url = `${API_BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `API error: ${response.status}`);
  }

  return response.json();
}

// Define available tools
const tools = [
  {
    name: 'list_projects',
    description: 'List all projects accessible to the authenticated user. Returns project names, IDs, status, and task counts.',
    inputSchema: {
      type: 'object',
      properties: {
        parent_id: {
          type: 'number',
          description: 'Filter by parent project ID to get sub-projects. Omit for top-level projects.',
        },
        status: {
          type: 'string',
          enum: ['active', 'completed', 'archived'],
          description: 'Filter by project status. Defaults to all.',
        },
      },
    },
  },
  {
    name: 'create_project',
    description: 'Create a new project. Returns the created project with its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the project',
        },
        description: {
          type: 'string',
          description: 'Description of the project',
        },
        parent_project_id: {
          type: 'number',
          description: 'Parent project ID if this is a sub-project',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_project',
    description: 'Update project details like name, description, or status.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'number',
          description: 'The ID of the project to update',
        },
        name: {
          type: 'string',
          description: 'New name for the project',
        },
        description: {
          type: 'string',
          description: 'New description',
        },
        status: {
          type: 'string',
          enum: ['active', 'completed', 'archived'],
          description: 'New status for the project',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'get_project',
    description: 'Get details of a specific project including name, description, status, and task statistics.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'number',
          description: 'The ID of the project to retrieve',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List all tasks for a specific project. Returns task titles, status, estimates, and time logged.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'number',
          description: 'The ID of the project whose tasks to list',
        },
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'done'],
          description: 'Filter by task status. Omit for all tasks.',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'get_task',
    description: 'Get detailed information about a specific task including description, acceptance criteria, time entries, and status.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'number',
          description: 'The ID of the task to retrieve',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'create_task',
    description: 'Create a new task in a project. Returns the created task with its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'number',
          description: 'The ID of the project to add the task to',
        },
        title: {
          type: 'string',
          description: 'Title of the task',
        },
        description: {
          type: 'string',
          description: 'Detailed description of the task',
        },
        acceptance_criteria: {
          type: 'string',
          description: 'Criteria for task completion',
        },
        estimated_minutes: {
          type: 'number',
          description: 'Estimated time to complete in minutes',
        },
        priority: {
          type: 'number',
          description: 'Priority level (0-5, higher is more important)',
        },
      },
      required: ['project_id', 'title'],
    },
  },
  {
    name: 'update_task',
    description: 'Update task details like title, description, estimates, or acceptance criteria.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'number',
          description: 'The ID of the task to update',
        },
        title: {
          type: 'string',
          description: 'New title for the task',
        },
        description: {
          type: 'string',
          description: 'New description',
        },
        acceptance_criteria: {
          type: 'string',
          description: 'New acceptance criteria',
        },
        estimated_minutes: {
          type: 'number',
          description: 'New time estimate in minutes',
        },
        priority: {
          type: 'number',
          description: 'New priority level',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'update_task_status',
    description: 'Change the status of a task (todo, in_progress, done). This triggers a real-time notification to users viewing the project.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'number',
          description: 'The ID of the task to update',
        },
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'done'],
          description: 'New status for the task',
        },
      },
      required: ['task_id', 'status'],
    },
  },
  {
    name: 'log_time',
    description: 'Log time spent on a task. This triggers a real-time notification showing time was logged.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'number',
          description: 'The ID of the task to log time against',
        },
        minutes: {
          type: 'number',
          description: 'Number of minutes to log',
        },
        notes: {
          type: 'string',
          description: 'Notes about what was done during this time',
        },
        date: {
          type: 'string',
          description: 'Date for the time entry (YYYY-MM-DD). Defaults to today.',
        },
      },
      required: ['task_id', 'minutes'],
    },
  },
  {
    name: 'search_tasks',
    description: 'Search for tasks across all projects by title or description.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to match against task titles and descriptions',
        },
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'done'],
          description: 'Filter results by status',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'quick_log',
    description: 'Quick workflow for logging completed work: creates a task, marks it done, and logs time in one call. Ideal for recording work that has already been completed.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'number',
          description: 'The ID of the project to add the task to',
        },
        title: {
          type: 'string',
          description: 'Title of the completed task',
        },
        minutes: {
          type: 'number',
          description: 'Number of minutes spent on this work',
        },
        description: {
          type: 'string',
          description: 'Detailed description of the task (optional)',
        },
        notes: {
          type: 'string',
          description: 'Notes about what was done during this time (optional, defaults to description if not provided)',
        },
        acceptance_criteria: {
          type: 'string',
          description: 'Criteria for task completion (optional)',
        },
      },
      required: ['project_id', 'title', 'minutes'],
    },
  },
  {
    name: 'start_working',
    description: 'Mark that you are actively working on a task. This shows other team members that the task is being worked on and by whom.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'number',
          description: 'The ID of the task to start working on',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'stop_working',
    description: 'Mark that you have stopped working on a task. Use this when taking a break or switching to another task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'number',
          description: 'The ID of the task to stop working on',
        },
      },
      required: ['task_id'],
    },
  },
  // Products tools
  {
    name: 'list_products',
    description: 'List all products accessible to the authenticated user. Products are top-level containers for organizing related projects.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'archived'],
          description: 'Filter by product status. Defaults to all.',
        },
      },
    },
  },
  {
    name: 'get_product',
    description: 'Get details of a specific product including linked projects, team members, and statistics.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: {
          type: 'number',
          description: 'The ID of the product to retrieve',
        },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'create_product',
    description: 'Create a new product. Products are top-level containers that can have multiple projects linked to them.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the product',
        },
        description: {
          type: 'string',
          description: 'Description of the product',
        },
        github_repo_url: {
          type: 'string',
          description: 'GitHub repository URL for the product',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'link_project_to_product',
    description: 'Link an existing project to a product.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: {
          type: 'number',
          description: 'The ID of the product',
        },
        project_id: {
          type: 'number',
          description: 'The ID of the project to link',
        },
        is_primary: {
          type: 'boolean',
          description: 'Whether this is the primary project for the product',
        },
      },
      required: ['product_id', 'project_id'],
    },
  },
];

// Tool implementation handlers
const toolHandlers = {
  async list_projects({ parent_id, status }) {
    let endpoint = '/projects';
    const params = new URLSearchParams();
    if (parent_id) params.set('parent_id', parent_id);
    if (status) params.set('status', status);
    if (params.toString()) endpoint += `?${params}`;

    const projects = await apiRequest(endpoint);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(projects, null, 2),
        },
      ],
    };
  },

  async create_project({ name, description, parent_project_id }) {
    const project = await apiRequest('/projects', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description,
        parent_project_id,
      }),
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(project, null, 2),
        },
      ],
    };
  },

  async update_project({ project_id, name, description, status }) {
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (status !== undefined) updates.status = status;

    const project = await apiRequest(`/projects/${project_id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(project, null, 2),
        },
      ],
    };
  },

  async get_project({ project_id }) {
    const project = await apiRequest(`/projects/${project_id}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(project, null, 2),
        },
      ],
    };
  },

  async list_tasks({ project_id, status }) {
    let endpoint = `/projects/${project_id}/tasks`;
    if (status) endpoint += `?status=${status}`;

    const tasks = await apiRequest(endpoint);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(tasks, null, 2),
        },
      ],
    };
  },

  async get_task({ task_id }) {
    const task = await apiRequest(`/tasks/${task_id}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(task, null, 2),
        },
      ],
    };
  },

  async create_task({ project_id, title, description, acceptance_criteria, estimated_minutes, priority }) {
    const task = await apiRequest(`/projects/${project_id}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        description,
        acceptance_criteria,
        estimated_minutes,
        priority,
      }),
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(task, null, 2),
        },
      ],
    };
  },

  async update_task({ task_id, title, description, acceptance_criteria, estimated_minutes, priority }) {
    const updates = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (acceptance_criteria !== undefined) updates.acceptance_criteria = acceptance_criteria;
    if (estimated_minutes !== undefined) updates.estimated_minutes = estimated_minutes;
    if (priority !== undefined) updates.priority = priority;

    const task = await apiRequest(`/tasks/${task_id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(task, null, 2),
        },
      ],
    };
  },

  async update_task_status({ task_id, status }) {
    const task = await apiRequest(`/tasks/${task_id}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    });
    return {
      content: [
        {
          type: 'text',
          text: `Task ${task_id} status updated to "${status}". This change has been broadcast to all connected users.`,
        },
      ],
    };
  },

  async log_time({ task_id, minutes, notes, date }) {
    const entry = await apiRequest(`/tasks/${task_id}/time`, {
      method: 'POST',
      body: JSON.stringify({
        minutes,
        notes,
        date: date || new Date().toISOString().split('T')[0],
      }),
    });
    return {
      content: [
        {
          type: 'text',
          text: `Logged ${minutes} minutes to task ${task_id}. ${notes ? `Notes: ${notes}` : ''}`,
        },
      ],
    };
  },

  async search_tasks({ query, status }) {
    let endpoint = `/tasks/search?q=${encodeURIComponent(query)}`;
    if (status) endpoint += `&status=${status}`;

    const tasks = await apiRequest(endpoint);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(tasks, null, 2),
        },
      ],
    };
  },

  async quick_log({ project_id, title, minutes, description, notes, acceptance_criteria }) {
    // Step 1: Create the task
    const task = await apiRequest(`/projects/${project_id}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        description,
        acceptance_criteria,
        estimated_minutes: minutes, // Use actual time as estimate since it's completed
      }),
    });

    const taskId = task.id;

    // Step 2: Mark task as done
    await apiRequest(`/tasks/${taskId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'done' }),
    });

    // Step 3: Log the time
    const timeNotes = notes || description || `Completed: ${title}`;
    await apiRequest(`/tasks/${taskId}/time`, {
      method: 'POST',
      body: JSON.stringify({
        minutes,
        notes: timeNotes,
        date: new Date().toISOString().split('T')[0],
      }),
    });

    return {
      content: [
        {
          type: 'text',
          text: `Created and completed task #${taskId}: "${title}"\n` +
                `Logged ${minutes} minutes to project ${project_id}\n` +
                `Notes: ${timeNotes}`,
        },
      ],
    };
  },

  async start_working({ task_id }) {
    await apiRequest(`/tasks/${task_id}/assignments`, {
      method: 'POST',
      body: JSON.stringify({ is_active: true }),
    });

    return {
      content: [
        {
          type: 'text',
          text: `Started working on task #${task_id}. Other team members can now see you are actively working on this task.`,
        },
      ],
    };
  },

  async stop_working({ task_id }) {
    await apiRequest(`/tasks/${task_id}/assignments?stop_only=true`, {
      method: 'DELETE',
    });

    return {
      content: [
        {
          type: 'text',
          text: `Stopped working on task #${task_id}. You are still assigned to the task but no longer marked as actively working.`,
        },
      ],
    };
  },

  // Products handlers
  async list_products({ status }) {
    let endpoint = '/products';
    if (status) endpoint += `?status=${status}`;

    const products = await apiRequest(endpoint);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(products, null, 2),
        },
      ],
    };
  },

  async get_product({ product_id }) {
    const product = await apiRequest(`/products/${product_id}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(product, null, 2),
        },
      ],
    };
  },

  async create_product({ name, description, github_repo_url }) {
    const product = await apiRequest('/products', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description,
        github_repo_url,
      }),
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(product, null, 2),
        },
      ],
    };
  },

  async link_project_to_product({ product_id, project_id, is_primary }) {
    const result = await apiRequest(`/products/${product_id}/projects`, {
      method: 'POST',
      body: JSON.stringify({
        project_id,
        is_primary: is_primary || false,
      }),
    });
    return {
      content: [
        {
          type: 'text',
          text: `Project ${project_id} linked to product ${product_id}. ${is_primary ? '(Primary project)' : ''}`,
        },
      ],
    };
  },
};

// Create and configure the MCP server
const server = new Server(
  {
    name: 'idea-base',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const handler = toolHandlers[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }

  try {
    return await handler(args);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('IDEA Base MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
