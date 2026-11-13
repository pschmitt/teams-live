export class GitLabClient {
  constructor({ host = 'git.wiit.one', token = null, group = '', onAuthError = null, onSuccess = null } = {}) {
    this.host = (host || 'git.wiit.one').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.token = token;
    this.group = group;
    this.onAuthError = onAuthError;
    this.onSuccess = onSuccess;
    this.currentUser = null;
    this.baseUrl = `https://${this.host}/api/v4`;
    const escapedHost = this.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    this.escapedHost = escapedHost;
    this.mrUrlRegex = new RegExp(`https?:\\/\\/${escapedHost}\\/([\\w.\\/-]+?)\\/-\\/merge_requests\\/(\\d+)`, 'g');
    this.jobUrlRegex = new RegExp(`https?:\\/\\/${escapedHost}\\/([\\w.\\/-]+?)\\/-\\/jobs\\/(\\d+)`, 'g');
    this.pipelineUrlRegex = new RegExp(`https?:\\/\\/${escapedHost}\\/([\\w.\\/-]+?)\\/-\\/pipelines\\/(\\d+)`, 'g');
  }

  async getCurrentUser() {
    if (this.currentUser) return this.currentUser;
    if (!this.token) return null;
    try {
      this.currentUser = await this.request('user');
      return this.currentUser;
    } catch {
      return null;
    }
  }

  async request(path, { method = 'GET', body = null, timeoutMs = 30_000 } = {}) {
    const url = `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
    const headers = {
      'User-Agent': 'teams-live/1.0',
    };
    if (this.token) {
      headers['PRIVATE-TOKEN'] = this.token;
    }
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const makeFetch = () =>
      fetch(url, {
        method,
        headers,
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

    let res;
    try {
      res = await makeFetch();
    } catch (err) {
      try {
        await new Promise((r) => setTimeout(r, 1000));
        res = await makeFetch();
      } catch (retryErr) {
        throw new Error(`GitLab request failed (${retryErr.cause?.message || retryErr.message})`);
      }
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let msg = errText;
      try {
        const parsed = JSON.parse(errText);
        msg = parsed.message || parsed.error || errText;
      } catch {
        // use raw text
      }
      const errStr = `GitLab error (${res.status}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
      if (res.status === 401 || res.status === 403) {
        this.onAuthError?.(errStr);
      }
      throw new Error(errStr);
    }
    this.onSuccess?.('GitLab');
    if (res.status === 204) {
      return {};
    }
    return await res.json();
  }

  findMrLinks(text, { allowQuotes = false } = {}) {
    const results = [];
    if (!text) return results;

    const textToSearch = allowQuotes
      ? text
      : text
          .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
          .replace(/<div[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[\s\S]*?<\/div>/gi, '');

    const seen = new Set();
    const seenBasenames = new Map();

    // 1. Full URLs (e.g. https://git.wiit.one/kubernetes/workload-clusters/-/merge_requests/596)
    for (const match of textToSearch.matchAll(this.mrUrlRegex)) {
      const project = match[1];
      const iid = match[2];
      const key = `${project}!${iid}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        const basename = project.split('/').pop().toLowerCase();
        if (!seenBasenames.has(basename)) seenBasenames.set(basename, new Set());
        seenBasenames.get(basename).add(String(iid));
        results.push({
          project,
          iid,
          url: match[0],
        });
      }
    }

    // 2. Shorthand references (e.g. workload-clusters!596, kubernetes/workload-clusters!596)
    const shorthandRegex = /(?:^|[^\w/.-])([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)!(\d+)(?=[^\w]|$)/g;
    for (const match of textToSearch.matchAll(shorthandRegex)) {
      let project = match[1];
      const iid = match[2];
      const basename = project.split('/').pop().toLowerCase();

      // If a full URL for this repository basename and iid was already found, skip this shorthand duplicate
      if (seenBasenames.get(basename)?.has(String(iid))) {
        continue;
      }

      if (!project.includes('/') && this.group) {
        project = `${this.group}/${project}`;
      }
      const key = `${project}!${iid}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        if (!seenBasenames.has(basename)) seenBasenames.set(basename, new Set());
        seenBasenames.get(basename).add(String(iid));
        results.push({
          project,
          iid,
          url: this.mrLink(project, iid),
        });
      }
    }

    return results;
  }

  findJobLinks(text, { allowQuotes = false } = {}) {
    const results = [];
    if (!text) return results;

    const textToSearch = allowQuotes
      ? text
      : text
          .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
          .replace(/<div[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[\s\S]*?<\/div>/gi, '');

    const seen = new Set();
    const regex = new RegExp(`https?:\\/\\/${this.escapedHost}\\/([\\w.\\/-]+?)\\/-\\/jobs\\/(\\d+)`, 'g');
    for (const match of textToSearch.matchAll(regex)) {
      const project = match[1];
      const jobId = match[2];
      const key = `${project}#job-${jobId}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          project,
          jobId,
          url: match[0],
        });
      }
    }
    return results;
  }

  findPipelineLinks(text, { allowQuotes = false } = {}) {
    const results = [];
    if (!text) return results;

    const textToSearch = allowQuotes
      ? text
      : text
          .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
          .replace(/<div[^>]*itemtype="http:\/\/schema\.skype\.com\/Reply"[\s\S]*?<\/div>/gi, '');

    const seen = new Set();
    const regex = new RegExp(`https?:\\/\\/${this.escapedHost}\\/([\\w.\\/-]+?)\\/-\\/pipelines\\/(\\d+)`, 'g');
    for (const match of textToSearch.matchAll(regex)) {
      const project = match[1];
      const pipelineId = match[2];
      const key = `${project}#pipeline-${pipelineId}`.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        results.push({
          project,
          pipelineId,
          url: match[0],
        });
      }
    }
    return results;
  }

  mrLink(project, iid) {
    return `https://${this.host}/${project}/-/merge_requests/${iid}`;
  }

  jobLink(project, jobId) {
    return `https://${this.host}/${project}/-/jobs/${jobId}`;
  }

  pipelineLink(project, pipelineId) {
    return `https://${this.host}/${project}/-/pipelines/${pipelineId}`;
  }

  async resolveProjectPath(projectOrName) {
    if (!projectOrName) return projectOrName;
    const parts = projectOrName.split('/');
    if (parts.length > 2) {
      return projectOrName;
    }
    const basename = parts.pop();
    const lower = basename.toLowerCase();

    if (!this.projectPathCache) this.projectPathCache = new Map();
    if (this.projectPathCache.has(lower)) {
      return this.projectPathCache.get(lower);
    }

    if (!this.group) return projectOrName;

    try {
      const res = await this.request(
        `groups/${encodeURIComponent(this.group)}/projects?include_subgroups=true&search=${encodeURIComponent(basename)}`
      );
      if (Array.isArray(res)) {
        const exact = res.find(
          (p) => p.path?.toLowerCase() === lower || p.name?.toLowerCase() === lower
        );
        if (exact) {
          const resolved = exact.path_with_namespace;
          this.projectPathCache.set(lower, resolved);
          return resolved;
        }
      }
    } catch {
      // fallback
    }

    return projectOrName.includes('/') ? projectOrName : `${this.group}/${projectOrName}`;
  }

  async getMr(project, iid) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${iid}?include_diverged_commits_count=true&include_rebase_in_progress=true`
    );
  }

  async approveMr(project, iid, { sha = null } = {}) {
    const body = sha ? { sha } : {};
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${iid}/approve`,
      { method: 'POST', body }
    );
  }

  async mergeMr(project, iid, {
    shouldRemoveSourceBranch = true,
    mergeWhenPipelineSucceeds = true,
    squash = null,
    sha = null,
  } = {}) {
    const body = {};
    if (shouldRemoveSourceBranch !== null) {
      body.should_remove_source_branch = shouldRemoveSourceBranch;
    }
    if (mergeWhenPipelineSucceeds !== null) {
      body.merge_when_pipeline_succeeds = mergeWhenPipelineSucceeds;
    }
    if (squash !== null) {
      body.squash = squash;
    }
    if (sha) {
      body.sha = sha;
    }
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${iid}/merge`,
      { method: 'PUT', body }
    );
  }

  async rebaseMr(project, iid, { skipCi = false } = {}) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${iid}/rebase`,
      { method: 'PUT', body: { skip_ci: skipCi } }
    );
  }

  async updateMr(project, iid, params = {}) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${iid}`,
      { method: 'PUT', body: params }
    );
  }

  async closeMr(project, iid) {
    return await this.updateMr(project, iid, { state_event: 'close' });
  }

  async reopenMr(project, iid) {
    return await this.updateMr(project, iid, { state_event: 'reopen' });
  }

  async getApprovals(project, iid) {
    return await this.request(`projects/${encodeURIComponent(project)}/merge_requests/${iid}/approvals`);
  }

  async getGroupMrs(group = null, { enrich = true } = {}) {
    const targetGroup = group || this.group;
    if (!targetGroup) {
      throw new Error('No GitLab group configured');
    }
    const endpoint = `groups/${encodeURIComponent(targetGroup)}/merge_requests?state=opened&wip=no&per_page=50&order_by=updated_at&sort=desc`;
    const mrs = await this.request(endpoint);
    if (!Array.isArray(mrs)) return [];
    const filtered = mrs.filter(
      (m) => !m.draft && !m.work_in_progress && !m.title.startsWith('Draft:') && !m.title.startsWith('WIP:')
    );

    if (!enrich || filtered.length === 0) {
      return filtered;
    }

    const enriched = await Promise.all(
      filtered.map(async (mr) => {
        try {
          const details = await this.getMr(mr.project_id, mr.iid);
          return {
            ...mr,
            head_pipeline: details.head_pipeline || mr.head_pipeline || null,
            diverged_commits_count: details.diverged_commits_count ?? mr.diverged_commits_count ?? null,
            rebase_in_progress: details.rebase_in_progress ?? mr.rebase_in_progress ?? false,
            has_conflicts: details.has_conflicts ?? mr.has_conflicts ?? false,
            detailed_merge_status: details.detailed_merge_status || mr.detailed_merge_status,
          };
        } catch {
          return mr;
        }
      })
    );

    return enriched;
  }

  async getPipelines(project, iid) {
    return await this.request(`projects/${encodeURIComponent(project)}/merge_requests/${iid}/pipelines?per_page=1`);
  }

  async getLatestPipeline(project, iid) {
    const pipelines = await this.getPipelines(project, iid);
    if (Array.isArray(pipelines) && pipelines.length > 0) {
      return pipelines[0];
    }
    return null;
  }

  async getPipeline(project, pipelineId) {
    return await this.request(`projects/${encodeURIComponent(project)}/pipelines/${pipelineId}`);
  }

  async getCommitMrs(project, sha) {
    if (!sha) return [];
    try {
      const res = await this.request(`projects/${encodeURIComponent(project)}/repository/commits/${sha}/merge_requests`);
      return Array.isArray(res) ? res : [];
    } catch {
      return [];
    }
  }

  async getMrForPipeline(project, pipeline) {
    if (!pipeline) return null;
    if (pipeline.sha) {
      const mrs = await this.getCommitMrs(project, pipeline.sha);
      if (mrs && mrs.length > 0) return mrs[0];
    }
    if (pipeline.ref) {
      try {
        const mrs = await this.request(
          `projects/${encodeURIComponent(project)}/merge_requests?source_branch=${encodeURIComponent(pipeline.ref)}&state=opened`
        );
        if (Array.isArray(mrs) && mrs.length > 0) return mrs[0];
      } catch {
        return null;
      }
    }
    return null;
  }

  async getJob(project, jobId) {
    return await this.request(`projects/${encodeURIComponent(project)}/jobs/${jobId}`);
  }

  async getMrForJob(project, jobData) {
    if (!jobData) return null;
    const sha = jobData.commit?.id || jobData.pipeline?.sha;
    if (sha) {
      const mrs = await this.getCommitMrs(project, sha);
      if (mrs && mrs.length > 0) return mrs[0];
    }
    if (jobData.ref) {
      try {
        const mrs = await this.request(
          `projects/${encodeURIComponent(project)}/merge_requests?source_branch=${encodeURIComponent(jobData.ref)}&state=opened`
        );
        if (Array.isArray(mrs) && mrs.length > 0) return mrs[0];
      } catch {
        return null;
      }
    }
    return null;
  }

  async getPipelineJobs(project, pipelineId) {
    return await this.request(`projects/${encodeURIComponent(project)}/pipelines/${pipelineId}/jobs?per_page=100`);
  }

  async retryPipeline(project, pipelineId) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/pipelines/${pipelineId}/retry`,
      { method: 'POST' }
    );
  }

  /**
   * Retrieves combined MR status, rebase/conflict status, and latest pipeline state.
   */
  async getMrStatus(project, iid) {
    const mr = await this.getMr(project, iid);
    const state = mr.state; // 'opened' | 'merged' | 'closed'

    let approved = false;
    let approvedBy = [];
    let status = state;

    if (state !== 'merged' && state !== 'closed') {
      try {
        const approvals = await this.getApprovals(project, iid);
        if (Array.isArray(approvals.approved_by)) {
          approvedBy = approvals.approved_by
            .map((a) => a.user?.name || a.user?.username || a.name || a.username)
            .filter(Boolean);
        }
        const approvalsRequired =
          typeof approvals.approvals_required === 'number' ? approvals.approvals_required : 0;
        approved = approvalsRequired > 0 ? Boolean(approvals.approved) : approvedBy.length > 0;
        status = approved ? 'approved' : 'pending';
      } catch {
        status = 'pending';
      }
    }

    const detailedMergeStatus = mr.detailed_merge_status || mr.merge_status;
    const hasConflicts = mr.has_conflicts === true || detailedMergeStatus === 'conflict';
    const diverged = typeof mr.diverged_commits_count === 'number' && mr.diverged_commits_count > 0;
    const needsRebase =
      state === 'opened' &&
      (detailedMergeStatus === 'need_rebase' || hasConflicts || mr.should_be_rebased === true || diverged);

    const isDraft = Boolean(
      mr.draft ||
      mr.work_in_progress ||
      mr.title?.startsWith('Draft:') ||
      mr.title?.startsWith('WIP:') ||
      detailedMergeStatus === 'draft_status'
    );

    let latestPipeline = null;
    try {
      const pipelines = await this.getPipelines(project, iid);
      if (Array.isArray(pipelines) && pipelines.length > 0) {
        latestPipeline = {
          id: pipelines[0].id,
          status: pipelines[0].status,
          web_url: pipelines[0].web_url,
          ref: pipelines[0].ref,
          sha: pipelines[0].sha,
        };
      }
    } catch {
      // Pipelines retrieval optional
    }

    return {
      project,
      iid,
      title: mr.title,
      description: mr.description,
      source_branch: mr.source_branch,
      draft: isDraft,
      web_url: mr.web_url,
      target_branch: mr.target_branch,
      state,
      approved,
      approvedBy,
      status, // 'pending' | 'approved' | 'merged' | 'closed'
      detailedMergeStatus,
      hasConflicts,
      needsRebase,
      pipeline: latestPipeline,
      autoMerge: Boolean(mr.merge_when_pipeline_succeeds),
      autoMergeUser: mr.merge_user ? (mr.merge_user.name || mr.merge_user.username) : null,
      autoMergeStrategy: mr.auto_merge_strategy || null,
    };
  }

  async getGroupHooks(group = null) {
    const targetGroup = group || this.group;
    if (!targetGroup) throw new Error('No GitLab group configured');
    return await this.request(`groups/${encodeURIComponent(targetGroup)}/hooks`);
  }

  async addGroupHook(group = null, hookData) {
    const targetGroup = group || this.group;
    if (!targetGroup) throw new Error('No GitLab group configured');
    return await this.request(`groups/${encodeURIComponent(targetGroup)}/hooks`, {
      method: 'POST',
      body: hookData,
    });
  }

  async editGroupHook(group = null, hookId, hookData) {
    const targetGroup = group || this.group;
    if (!targetGroup) throw new Error('No GitLab group configured');
    return await this.request(`groups/${encodeURIComponent(targetGroup)}/hooks/${hookId}`, {
      method: 'PUT',
      body: hookData,
    });
  }

  async deleteGroupHook(group = null, hookId) {
    const targetGroup = group || this.group;
    if (!targetGroup) throw new Error('No GitLab group configured');
    return await this.request(`groups/${encodeURIComponent(targetGroup)}/hooks/${hookId}`, {
      method: 'DELETE',
    });
  }

  /**
   * Ensures a group webhook exists with the specified URL and events.
   * If an existing hook with the same URL is found, updates it if needed.
   * Otherwise creates a new group webhook.
   */
  async ensureGroupWebhook({
    group = null,
    url,
    secretToken = null,
    events = {},
  } = {}) {
    if (!url) throw new Error('Webhook URL is required');
    const targetGroup = group || this.group;
    if (!targetGroup) throw new Error('No GitLab group configured');

    const hookData = {
      url,
      merge_requests_events: events.merge_requests ?? true,
      pipeline_events: events.pipeline ?? true,
      job_events: events.job ?? false,
      note_events: events.note ?? false,
      enable_ssl_verification: events.enable_ssl_verification ?? true,
    };
    if (secretToken) {
      hookData.token = secretToken;
    }

    const hooks = await this.getGroupHooks(targetGroup);
    const existing = Array.isArray(hooks) ? hooks.find((h) => h.url === url) : null;

    if (existing) {
      const needsUpdate =
        existing.merge_requests_events !== hookData.merge_requests_events ||
        existing.pipeline_events !== hookData.pipeline_events ||
        existing.enable_ssl_verification !== hookData.enable_ssl_verification ||
        Boolean(secretToken);

      if (needsUpdate) {
        const updated = await this.editGroupHook(targetGroup, existing.id, hookData);
        return { action: 'updated', hook: updated };
      }
      return { action: 'unchanged', hook: existing };
    }

    const created = await this.addGroupHook(targetGroup, hookData);
    return { action: 'created', hook: created };
  }

  async getCurrentUser() {
    if (this._currentUser) return this._currentUser;
    this._currentUser = await this.request('user');
    return this._currentUser;
  }

  async getAwardEmojis(project, mrIid) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${mrIid}/award_emoji?per_page=100`
    );
  }

  async awardEmoji(project, mrIid, name) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${mrIid}/award_emoji`,
      {
        method: 'POST',
        body: { name },
      }
    );
  }

  async deleteAwardEmoji(project, mrIid, awardId) {
    return await this.request(
      `projects/${encodeURIComponent(project)}/merge_requests/${mrIid}/award_emoji/${awardId}`,
      { method: 'DELETE' }
    );
  }
}
