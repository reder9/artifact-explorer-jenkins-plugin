package io.jenkins.plugins.artifactexplorer;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import hudson.Launcher;
import hudson.model.AbstractBuild;
import hudson.model.Action;
import hudson.model.BuildListener;
import hudson.model.FreeStyleProject;
import hudson.model.Run;
import hudson.tasks.ArtifactArchiver;
import java.io.IOException;
import java.util.Collection;
import java.util.Collections;
import jenkins.model.TransientActionFactory;
import org.htmlunit.Page;
import org.junit.jupiter.api.Test;
import org.jvnet.hudson.test.JenkinsRule;
import org.jvnet.hudson.test.TestBuilder;
import org.jvnet.hudson.test.TestExtension;
import org.jvnet.hudson.test.junit.jupiter.WithJenkins;
import org.kohsuke.stapler.StaplerResponse2;

/**
 * Phase 0 spike, kept as a regression guard. The plugin takes over {@code /artifact/} with a servlet filter because a
 * {@link Action} named {@code artifact} is expected to LOSE against core's {@code Run.doArtifact()}. If this test ever
 * fails, core changed and a simpler action-based replacement became possible.
 */
@WithJenkins
class RoutingAssumptionsTest {

    @Test
    void actionNamedArtifactDoesNotShadowCore(JenkinsRule j) throws Exception {
        FreeStyleProject p = j.createFreeStyleProject("p");
        // Archive something so core's directory browser has a real directory to render (it 404s otherwise).
        p.getBuildersList().add(new TestBuilder() {
            @Override
            public boolean perform(AbstractBuild<?, ?> build, Launcher launcher, BuildListener listener)
                    throws InterruptedException, IOException {
                build.getWorkspace().child("a.txt").write("hello", "UTF-8");
                return true;
            }
        });
        p.getPublishersList().add(new ArtifactArchiver("a.txt"));
        j.buildAndAssertSuccess(p);

        JenkinsRule.WebClient wc = j.createWebClient();
        wc.getOptions().setJavaScriptEnabled(false);
        // ?legacy=1 keeps our own filter out of the picture so only core vs. the shadow action is compared.
        Page page = wc.goTo("job/p/1/artifact/?legacy=1", null);
        String body = page.getWebResponse().getContentAsString();

        assertFalse(body.contains("SHADOW-ACTION"), "an action named 'artifact' unexpectedly won over doArtifact()");
        assertTrue(body.contains("a.txt"), "core directory browser expected to list the archived file");
    }

    @TestExtension("actionNamedArtifactDoesNotShadowCore")
    @SuppressWarnings("rawtypes")
    public static class ShadowFactory extends TransientActionFactory<Run> {
        @Override
        public Class<Run> type() {
            return Run.class;
        }

        @Override
        public Collection<? extends Action> createFor(Run target) {
            return Collections.singletonList(new Action() {
                @Override
                public String getIconFileName() {
                    return null;
                }

                @Override
                public String getDisplayName() {
                    return null;
                }

                @Override
                public String getUrlName() {
                    return "artifact";
                }

                @SuppressWarnings("unused")
                public void doIndex(StaplerResponse2 rsp) throws IOException {
                    rsp.setContentType("text/plain");
                    rsp.getWriter().write("SHADOW-ACTION");
                }
            });
        }
    }
}
