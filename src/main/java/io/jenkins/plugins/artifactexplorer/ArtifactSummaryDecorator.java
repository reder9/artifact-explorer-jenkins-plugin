package io.jenkins.plugins.artifactexplorer;

import hudson.Extension;
import hudson.model.PageDecorator;

/**
 * Injects client-side scripts to progressively enhance classic artifact summaries
 * (e.g. "Last Successful Artifacts" on Job pages and "Build Artifacts" on Build pages)
 * into a modern collapsible tree with search, folder navigation, and a direct link to the full Artifact Explorer.
 */
@Extension
public final class ArtifactSummaryDecorator extends PageDecorator {

    public ArtifactSummaryDecorator() {
        super();
    }

    public boolean isEnabled() {
        ExplorerConfiguration cfg = ExplorerConfiguration.get();
        return cfg == null || cfg.isReplaceClassicBrowser();
    }
}
