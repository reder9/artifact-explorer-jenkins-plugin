package io.jenkins.plugins.artifactexplorer;

import edu.umd.cs.findbugs.annotations.NonNull;
import hudson.Extension;
import hudson.model.Action;
import hudson.model.Run;
import java.util.Collection;
import java.util.Collections;
import jenkins.model.TransientActionFactory;

/** Attaches an {@link ArtifactExplorerAction} to every build. */
@Extension
@SuppressWarnings("rawtypes")
public class ArtifactExplorerActionFactory extends TransientActionFactory<Run> {

    @Override
    public Class<Run> type() {
        return Run.class;
    }

    @NonNull
    @Override
    public Collection<? extends Action> createFor(Run target) {
        if (target == null) {
            return Collections.emptyList();
        }
        return Collections.singletonList(new ArtifactExplorerAction(target));
    }
}
