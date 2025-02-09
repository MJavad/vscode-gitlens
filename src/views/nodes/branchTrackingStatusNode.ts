import { MarkdownString, ThemeColor, ThemeIcon, TreeItem, TreeItemCollapsibleState, window } from 'vscode';
import type { Colors } from '../../constants';
import type { FilesComparison } from '../../git/actions/commit';
import { GitUri } from '../../git/gitUri';
import type { GitBranch, GitTrackingState } from '../../git/models/branch';
import { getRemoteNameFromBranchName } from '../../git/models/branch';
import type { GitLog } from '../../git/models/log';
import { createRevisionRange } from '../../git/models/reference';
import { getHighlanderProviders } from '../../git/models/remote';
import { fromNow } from '../../system/date';
import { gate } from '../../system/decorators/gate';
import { debug } from '../../system/decorators/log';
import { first, last, map } from '../../system/iterable';
import { pluralize } from '../../system/string';
import type { ViewsWithCommits } from '../viewBase';
import type { PageableViewNode } from './abstract/viewNode';
import { ContextValues, getViewNodeId, ViewNode } from './abstract/viewNode';
import { BranchTrackingStatusFilesNode } from './branchTrackingStatusFilesNode';
import { CommitNode } from './commitNode';
import { LoadMoreNode } from './common';
import { insertDateMarkers } from './helpers';

export interface BranchTrackingStatus {
	ref: string;
	repoPath: string;
	state: GitTrackingState;
	upstream?: string;
}

export class BranchTrackingStatusNode
	extends ViewNode<'tracking-status', ViewsWithCommits>
	implements PageableViewNode
{
	limit: number | undefined;

	constructor(
		view: ViewsWithCommits,
		protected override readonly parent: ViewNode,
		public readonly branch: GitBranch,
		public readonly status: BranchTrackingStatus,
		public readonly upstreamType: 'ahead' | 'behind' | 'same' | 'missing' | 'none',
		// Specifies that the node is shown as a root
		public readonly root: boolean = false,
		private readonly options?: {
			showAheadCommits?: boolean;
			unpublishedCommits?: Set<string>;
		},
	) {
		super('tracking-status', GitUri.fromRepoPath(status.repoPath), view, parent);

		this.updateContext({
			branch: branch,
			branchStatus: status,
			branchStatusUpstreamType: upstreamType,
			root: root,
		});
		this._uniqueId = getViewNodeId(this.type, this.context);
		this.limit = this.view.getNodeLastKnownLimit(this);
	}

	override get id(): string {
		return this._uniqueId;
	}

	get repoPath(): string {
		return this.uri.repoPath!;
	}

	async getFilesComparison(): Promise<FilesComparison | undefined> {
		// if we are ahead we don't actually add the files node, just each of its children individually
		if (this.upstreamType === 'ahead') {
			const node = new BranchTrackingStatusFilesNode(
				this.view,
				this,
				this.branch,
				this.status as Required<BranchTrackingStatus>,
				this.upstreamType,
			);

			const comparison = await node?.getFilesComparison();
			if (comparison == null) return undefined;

			// Get the oldest unpublished (unpushed) commit
			const ref = this.options?.unpublishedCommits != null ? last(this.options.unpublishedCommits) : undefined;
			if (ref == null) return undefined;

			const resolved = await this.view.container.git.resolveReference(this.repoPath, `${ref}^`);
			return {
				...comparison,
				ref1: resolved,
				ref2: comparison.ref1,
				title: `Changes to push to ${comparison.ref2}`,
			};
		}

		const children = await this.getChildren();
		const node = children.find(c => c.is('tracking-status-files')) as BranchTrackingStatusFilesNode | undefined;
		return node?.getFilesComparison();
	}

	async getChildren(): Promise<ViewNode[]> {
		if (this.upstreamType === 'same' || this.upstreamType === 'missing' || this.upstreamType === 'none') return [];

		const log = await this.getLog();
		if (log == null) return [];

		let commits;
		if (this.upstreamType === 'ahead') {
			// Since the last commit when we are looking 'ahead' can have no previous (because of the range given) -- look it up
			commits = [...log.commits.values()];
			const commit = commits[commits.length - 1];
			const previousSha = await commit.getPreviousSha();
			if (previousSha == null) {
				const previousLog = await this.view.container.git.getLog(this.uri.repoPath!, {
					limit: 2,
					ref: commit.sha,
				});
				if (previousLog != null) {
					commits[commits.length - 1] = first(previousLog.commits.values())!;
				}
			}
		} else {
			commits = log.commits.values();
		}

		const children = [];

		let showFiles = true;
		if (
			!this.options?.showAheadCommits &&
			this.upstreamType === 'ahead' &&
			this.status.upstream &&
			this.status.state.ahead > 0
		) {
			showFiles = false;
			// TODO@eamodio fix this
			children.push(
				...(await new BranchTrackingStatusFilesNode(
					this.view,
					this,
					this.branch,
					this.status as Required<BranchTrackingStatus>,
					this.upstreamType,
				).getChildren()),
			);
		} else {
			children.push(
				...insertDateMarkers(
					map(commits, c => new CommitNode(this.view, this, c, this.upstreamType === 'ahead', this.branch)),
					this,
					1,
				),
			);

			if (log.hasMore) {
				children.push(new LoadMoreNode(this.view, this, children[children.length - 1]));
			}
		}

		if (showFiles) {
			children.unshift(
				new BranchTrackingStatusFilesNode(
					this.view,
					this,
					this.branch,
					this.status as Required<BranchTrackingStatus>,
					this.upstreamType,
				),
			);
		}

		return children;
	}

	async getTreeItem(): Promise<TreeItem> {
		let lastFetched = 0;

		if (this.upstreamType !== 'missing' && this.upstreamType !== 'none') {
			const repo = this.view.container.git.getRepository(this.repoPath);
			lastFetched = (await repo?.getLastFetched()) ?? 0;
		}

		let label;
		let description;
		let collapsibleState;
		let contextValue;
		let icon;
		let tooltip;
		switch (this.upstreamType) {
			case 'ahead': {
				const remote = await this.branch.getRemote();

				label = `Changes to push to ${remote?.name ?? getRemoteNameFromBranchName(this.status.upstream!)}${
					remote?.provider?.name ? ` on ${remote?.provider.name}` : ''
				}`;
				description = pluralize('commit', this.status.state.ahead);
				tooltip = `Outgoing changes to push\n\nBranch $(git-branch) ${this.branch.name} is ${pluralize(
					'commit',
					this.status.state.ahead,
					{
						infix: '$(arrow-up) ',
					},
				)} ahead of $(git-branch) ${this.status.upstream}${
					remote?.provider?.name ? ` on ${remote.provider.name}` : ''
				}`;

				collapsibleState = TreeItemCollapsibleState.Collapsed;
				contextValue = this.root
					? ContextValues.StatusAheadOfUpstream
					: ContextValues.BranchStatusAheadOfUpstream;
				icon = new ThemeIcon(
					'cloud-upload',
					new ThemeColor('gitlens.unpublishedChangesIconColor' satisfies Colors),
				);

				break;
			}
			case 'behind': {
				const remote = await this.branch.getRemote();

				label = `Changes to pull from ${remote?.name ?? getRemoteNameFromBranchName(this.status.upstream!)}${
					remote?.provider?.name ? ` on ${remote.provider.name}` : ''
				}`;
				description = pluralize('commit', this.status.state.behind);
				tooltip = `Incoming changes to pull\n\nBranch $(git-branch) ${this.branch.name} is ${pluralize(
					'commit',
					this.status.state.behind,
					{
						infix: '$(arrow-down) ',
					},
				)} behind $(git-branch) ${this.status.upstream}${
					remote?.provider?.name ? ` on ${remote.provider.name}` : ''
				}`;

				collapsibleState = TreeItemCollapsibleState.Collapsed;
				contextValue = this.root
					? ContextValues.StatusBehindUpstream
					: ContextValues.BranchStatusBehindUpstream;
				icon = new ThemeIcon(
					'cloud-download',
					new ThemeColor('gitlens.unpulledChangesIconColor' satisfies Colors),
				);

				break;
			}
			case 'same': {
				const remote = await this.branch.getRemote();

				label = `Up to date with ${remote?.name ?? getRemoteNameFromBranchName(this.status.upstream!)}${
					remote?.provider?.name ? ` on ${remote.provider.name}` : ''
				}`;
				description = lastFetched ? `Last fetched ${fromNow(new Date(lastFetched))}` : '';
				tooltip = `Branch $(git-branch) ${this.branch.name} is up to date with $(git-branch) ${
					this.status.upstream
				}${remote?.provider?.name ? ` on ${remote.provider.name}` : ''}`;

				collapsibleState = TreeItemCollapsibleState.None;
				contextValue = this.root
					? ContextValues.StatusSameAsUpstream
					: ContextValues.BranchStatusSameAsUpstream;
				icon = new ThemeIcon('cloud');

				break;
			}
			case 'missing': {
				const remote = await this.branch.getRemote();

				label = `Missing upstream branch${remote?.provider?.name ? ` on ${remote.provider.name}` : ''}`;
				description = this.status.upstream;
				tooltip = `Branch $(git-branch) ${this.branch.name} is missing upstream $(git-branch) ${
					this.status.upstream
				}${remote?.provider?.name ? ` on ${remote.provider.name}` : ''}`;

				collapsibleState = TreeItemCollapsibleState.None;
				contextValue = this.root
					? ContextValues.StatusMissingUpstream
					: ContextValues.BranchStatusSameAsUpstream;
				icon = new ThemeIcon(
					'warning',
					new ThemeColor('gitlens.decorations.branchMissingUpstreamForegroundColor' satisfies Colors),
				);

				break;
			}
			case 'none': {
				const remotes = await this.view.container.git.getRemotesWithProviders(this.branch.repoPath);
				const providers = getHighlanderProviders(remotes);
				const providerName = providers?.length ? providers[0].name : undefined;

				label = `Publish ${this.branch.name} to ${providerName ?? 'a remote'}`;
				tooltip = `Branch $(git-branch) ${this.branch.name} hasn't been published to ${
					providerName ?? 'a remote'
				}`;

				collapsibleState = TreeItemCollapsibleState.None;
				contextValue = this.root ? ContextValues.StatusNoUpstream : ContextValues.BranchStatusNoUpstream;
				icon = new ThemeIcon(
					'cloud-upload',
					remotes.length ? new ThemeColor('gitlens.unpublishedChangesIconColor' satisfies Colors) : undefined,
				);

				break;
			}
		}

		const item = new TreeItem(label, collapsibleState);
		item.id = this.id;
		item.contextValue = contextValue;
		item.description = description;
		if (lastFetched) {
			tooltip += `\n\nLast fetched ${fromNow(new Date(lastFetched))}`;
		}
		item.iconPath = icon;

		const markdown = new MarkdownString(tooltip, true);
		markdown.supportHtml = true;
		markdown.isTrusted = true;

		item.tooltip = markdown;

		return item;
	}

	@gate()
	@debug()
	override refresh(reset?: boolean) {
		if (reset) {
			this._log = undefined;
		}
	}

	private _log: GitLog | undefined;
	private async getLog() {
		if (this.upstreamType === 'same' || this.upstreamType === 'none') return undefined;

		if (this._log == null) {
			const range =
				this.upstreamType === 'ahead'
					? createRevisionRange(this.status.upstream, this.status.ref)
					: createRevisionRange(this.status.ref, this.status.upstream);

			this._log = await this.view.container.git.getLog(this.uri.repoPath!, {
				limit: this.limit ?? this.view.config.defaultItemLimit,
				ref: range,
			});
		}

		return this._log;
	}

	get hasMore() {
		return this._log?.hasMore ?? true;
	}

	@gate()
	async loadMore(limit?: number | { until?: any }) {
		let log = await window.withProgress(
			{
				location: { viewId: this.view.id },
			},
			() => this.getLog(),
		);
		if (log == null || !log.hasMore) return;

		log = await log.more?.(limit ?? this.view.config.pageItemLimit);
		if (this._log === log) return;

		this._log = log;
		this.limit = log?.count;

		void this.triggerChange(false);
	}
}
