const config = require('../../.github/reviewer-routing.json');

function selectReviewers({ labels, author, requested = [], reviewed = [] }, routing = config) {
  const matched = labels.filter(label => Object.hasOwn(routing.reviewers, label));
  const candidates = matched.length
    ? matched.flatMap(label => routing.reviewers[label])
    : routing.fallback;
  const excluded = new Set([author, ...requested, ...reviewed].map(name => name.toLowerCase()));
  return [...new Map(candidates.map(name => [name.toLowerCase(), name])).values()]
    .filter(name => !excluded.has(name.toLowerCase()) && !name.endsWith('[bot]'));
}

async function run({ github, context, core }) {
  const repo = context.repo;
  if (context.eventName !== 'pull_request_target') {
    // Only create missing labels. Never delete labels or overwrite manual edits.
    for (const label of config.labels) {
      try {
        await github.rest.issues.getLabel({ ...repo, name: label.name });
      } catch (error) {
        if (error.status !== 404) throw error;
        await github.rest.issues.createLabel({ ...repo, ...label });
      }
    }
    await core.summary.addHeading('Labels / 标签')
      .addRaw('Configured labels exist; existing labels are preserved. / 配置中的标签已存在，保留原有标签。')
      .write();
    return;
  }
  const pull_number = context.payload.pull_request.number;
  // Read current state rather than routing from a potentially stale event payload.
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number });
  if (pr.state !== 'open' || pr.draft) {
    core.info('Skip closed or draft PR / 跳过已关闭或草稿 PR');
    return;
  }
  if (context.payload.action === 'unlabeled' &&
      !pr.labels.some(label => Object.hasOwn(config.reviewers, label.name))) {
    core.info('Label removed with no mapped labels remaining; skip fallback / 移除后无匹配标签，跳过默认名单');
    return;
  }
  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    ...repo, pull_number, per_page: 100,
  });
  const reviewers = selectReviewers({
    labels: pr.labels.map(label => label.name),
    author: pr.user.login,
    requested: pr.requested_reviewers.map(user => user.login),
    reviewed: reviews.filter(review => review.state !== 'PENDING').map(review => review.user?.login).filter(Boolean),
  });
  const rows = [];
  // Request separately: one unavailable account must not prevent the others.
  for (const reviewer of reviewers) {
    try {
      await github.rest.pulls.requestReviewers({ ...repo, pull_number, reviewers: [reviewer] });
      rows.push([reviewer, 'Requested / 已邀请']);
    } catch (error) {
      if (error.status !== 422) throw error;
      core.warning(`Cannot request ${reviewer}: ${error.message}`);
      rows.push([reviewer, 'Unavailable; see warning / 无法邀请，见警告']);
    }
  }
  await core.summary.addHeading('Reviewer routing / 审查人分配')
    .addRaw(`PR #${pull_number}\n`)
    .addTable([['Reviewer / 审查人', 'Result / 结果'], ...rows])
    .addRaw('Existing requests and submitted reviews are preserved. No matching label uses fallback except on label removal. / 保留已有邀请和已提交审查；无匹配标签时使用默认名单，移除标签事件除外。')
    .write();
}
module.exports = { selectReviewers, run };
