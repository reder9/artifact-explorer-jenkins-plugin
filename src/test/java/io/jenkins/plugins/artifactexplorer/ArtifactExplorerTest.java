package io.jenkins.plugins.artifactexplorer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import hudson.FilePath;
import hudson.Launcher;
import hudson.model.AbstractBuild;
import hudson.model.BuildListener;
import hudson.model.FreeStyleProject;
import hudson.model.Item;
import hudson.model.Run;
import hudson.tasks.ArtifactArchiver;
import java.io.IOException;
import jenkins.model.Jenkins;
import net.sf.json.JSONArray;
import net.sf.json.JSONObject;
import org.htmlunit.html.HtmlPage;
import org.junit.jupiter.api.Test;
import org.jvnet.hudson.test.JenkinsRule;
import org.jvnet.hudson.test.MockAuthorizationStrategy;
import org.jvnet.hudson.test.TestBuilder;
import org.jvnet.hudson.test.junit.jupiter.WithJenkins;

@WithJenkins
class ArtifactExplorerTest {

    private static FreeStyleProject projectWithArtifacts(JenkinsRule j, String name) throws Exception {
        FreeStyleProject p = j.createFreeStyleProject(name);
        p.getBuildersList().add(new TestBuilder() {
            @Override
            public boolean perform(AbstractBuild<?, ?> build, Launcher launcher, BuildListener listener)
                    throws InterruptedException, IOException {
                FilePath ws = build.getWorkspace();
                ws.child("dist/a.txt").write("hello", "UTF-8");
                ws.child("dist/sub/b.js").write("console.log(1)", "UTF-8");
                ws.child("dist/sub/deeper/c.css").write("body{}", "UTF-8");
                ws.child("root.txt").write("r", "UTF-8");
                return true;
            }
        });
        p.getPublishersList().add(new ArtifactArchiver("**"));
        j.buildAndAssertSuccess(p);
        return p;
    }

    private static JenkinsRule.WebClient client(JenkinsRule j) {
        JenkinsRule.WebClient wc = j.createWebClient();
        wc.getOptions().setJavaScriptEnabled(false);
        return wc;
    }

    private static JSONObject json(JenkinsRule.WebClient wc, String url) throws Exception {
        return JSONObject.fromObject(wc.goTo(url, "application/json").getWebResponse().getContentAsString());
    }

    @Test
    void directoryPageIsReplacedAtTheClassicUrl(JenkinsRule j) throws Exception {
        projectWithArtifacts(j, "p");
        HtmlPage page = client(j).goTo("job/p/1/artifact/dist/");
        assertNotNull(page.getElementById("artifact-explorer"), "explorer should render at the classic URL");
        assertEquals("dist", page.getElementById("artifact-explorer").getAttribute("data-initial-path"));
    }

    @Test
    void rootAndPermalinkUrlsAreReplaced(JenkinsRule j) throws Exception {
        projectWithArtifacts(j, "p");
        JenkinsRule.WebClient wc = client(j);
        assertEquals(
                "",
                wc.goTo("job/p/1/artifact/").getElementById("artifact-explorer").getAttribute("data-initial-path"));
        assertNotNull(wc.goTo("job/p/lastSuccessfulBuild/artifact/dist/").getElementById("artifact-explorer"));
    }

    @Test
    void encodedJobNamesWork(JenkinsRule j) throws Exception {
        projectWithArtifacts(j, "my project");
        HtmlPage page = client(j).goTo("job/my%20project/1/artifact/dist/sub/");
        assertNotNull(page.getElementById("artifact-explorer"));
        assertEquals("dist/sub", page.getElementById("artifact-explorer").getAttribute("data-initial-path"));
    }

    @Test
    void legacyParameterKeepsTheClassicPage(JenkinsRule j) throws Exception {
        projectWithArtifacts(j, "p");
        HtmlPage page = client(j).goTo("job/p/1/artifact/dist/?legacy=1");
        assertEquals(null, page.getElementById("artifact-explorer"));
        assertTrue(page.asXml().contains("fileList"), "classic listing expected");
    }

    @Test
    void canBeSwitchedOffGlobally(JenkinsRule j) throws Exception {
        projectWithArtifacts(j, "p");
        JenkinsRule.WebClient wc = client(j);

        // Enabled by default: summary decorator scripts are present
        HtmlPage buildPageEnabled = wc.goTo("job/p/1/");
        assertTrue(buildPageEnabled.asXml().contains("summary-tree.js"));

        // Switch off globally
        ExplorerConfiguration.get().setReplaceClassicBrowser(false);
        assertFalse(ExplorerConfiguration.get().isReplaceClassicBrowser());

        // 1. Directory browser falls back to classic core listing
        HtmlPage page = wc.goTo("job/p/1/artifact/dist/");
        assertEquals(null, page.getElementById("artifact-explorer"));
        assertTrue(page.asXml().contains("fileList"));

        // 2. Build summary page decorator is also completely disabled
        HtmlPage buildPageDisabled = wc.goTo("job/p/1/");
        assertFalse(buildPageDisabled.asXml().contains("summary-tree.js"));
        assertFalse(buildPageDisabled.asXml().contains("summary-tree.css"));
    }

    @Test
    void fileDownloadsStillComeFromCore(JenkinsRule j) throws Exception {
        projectWithArtifacts(j, "p");
        JenkinsRule.WebClient wc = client(j);
        assertEquals(
                "hello",
                wc.goTo("job/p/1/artifact/dist/a.txt", null).getWebResponse().getContentAsString());
        assertEquals(
                200,
                wc.goTo("job/p/1/artifact/dist/*zip*/dist.zip", "application/zip")
                        .getWebResponse()
                        .getStatusCode());
    }

    @Test
    void treeApiListsDirectoriesFirst(JenkinsRule j) throws Exception {
        projectWithArtifacts(j, "p");
        JSONObject data = json(client(j), "job/p/1/artifact-explorer/tree?path=dist").getJSONObject("data");
        JSONArray entries = data.getJSONArray("entries");
        assertEquals(2, entries.size());
        assertEquals("sub", entries.getJSONObject(0).getString("name"));
        assertTrue(entries.getJSONObject(0).getBoolean("directory"));
        assertEquals("dist/sub", entries.getJSONObject(0).getString("path"));
        assertEquals("a.txt", entries.getJSONObject(1).getString("name"));
        assertEquals(5, entries.getJSONObject(1).getLong("size"));
        assertFalse(data.getBoolean("truncated"));
    }

    @Test
    void searchIndexContainsAllFiles(JenkinsRule j) throws Exception {
        projectWithArtifacts(j, "p");
        JSONArray files =
                json(client(j), "job/p/1/artifact-explorer/searchIndex").getJSONObject("data").getJSONArray("files");
        assertEquals(4, files.size());
        assertTrue(files.contains("dist/sub/deeper/c.css"));
        assertTrue(files.contains("root.txt"));
    }

    @Test
    void entriesAreTruncatedAtTheConfiguredLimit(JenkinsRule j) throws Exception {
        projectWithArtifacts(j, "p");
        ExplorerConfiguration.get().setMaxEntries(1);
        JSONObject data = json(client(j), "job/p/1/artifact-explorer/tree?path=dist").getJSONObject("data");
        assertEquals(1, data.getJSONArray("entries").size());
        assertTrue(data.getBoolean("truncated"));
    }

    @Test
    void traversalAndMissingPathsAreRejected(JenkinsRule j) throws Exception {
        projectWithArtifacts(j, "p");
        JenkinsRule.WebClient wc = client(j);
        assertEquals("error", json(wc, "job/p/1/artifact-explorer/tree?path=../..").getString("status"));
        assertEquals("error", json(wc, "job/p/1/artifact-explorer/tree?path=dist/../../x").getString("status"));
        assertEquals("error", json(wc, "job/p/1/artifact-explorer/tree?path=nope").getString("status"));
        assertEquals("error", json(wc, "job/p/1/artifact-explorer/tree?path=dist/a.txt").getString("status"));
    }

    @Test
    void artifactsPermissionIsEnforcedWhenEnabled(JenkinsRule j) throws Exception {
        String property = "hudson.security.ArtifactsPermission";
        String previous = System.getProperty(property);
        System.setProperty(property, "true");
        try {
            projectWithArtifacts(j, "p");
            j.jenkins.setSecurityRealm(j.createDummySecurityRealm());
            j.jenkins.setAuthorizationStrategy(new MockAuthorizationStrategy()
                    .grant(Jenkins.READ, Item.READ)
                    .everywhere()
                    .to("alice")
                    .grant(Jenkins.READ, Item.READ, Run.ARTIFACTS)
                    .everywhere()
                    .to("bob"));

            JenkinsRule.WebClient alice = client(j).login("alice");
            alice.assertFails("job/p/1/artifact-explorer/tree?path=dist", 403);
            alice.assertFails("job/p/1/artifact-explorer/searchIndex", 403);
            alice.assertFails("job/p/1/artifact-explorer/preview?path=dist/a.txt", 403);
            alice.assertFails("job/p/1/artifact-explorer/", 403);

            JenkinsRule.WebClient bob = client(j).login("bob");
            assertEquals("ok", json(bob, "job/p/1/artifact-explorer/tree?path=dist").getString("status"));
            assertNotNull(bob.goTo("job/p/1/artifact/dist/").getElementById("artifact-explorer"));
        } finally {
            if (previous == null) {
                System.clearProperty(property);
            } else {
                System.setProperty(property, previous);
            }
        }
    }

    @Test
    void sidebarEntryOnlyAppearsWhenThereAreArtifacts(JenkinsRule j) throws Exception {
        FreeStyleProject empty = j.createFreeStyleProject("empty");
        j.buildAndAssertSuccess(empty);
        ArtifactExplorerAction none = new ArtifactExplorerAction(empty.getLastBuild());
        assertEquals(null, none.getIconFileName());

        FreeStyleProject p = projectWithArtifacts(j, "p");
        assertEquals("symbol-cube", new ArtifactExplorerAction(p.getLastBuild()).getIconFileName());
    }

    @Test
    void previewApiReturnsTextAndDetectsBinaryAndTruncation(JenkinsRule j) throws Exception {
        FreeStyleProject p = projectWithArtifacts(j, "p");
        JenkinsRule.WebClient wc = client(j);

        JSONObject ok = json(wc, "job/p/1/artifact-explorer/preview?path=dist/a.txt");
        assertEquals("ok", ok.getString("status"));
        JSONObject data = ok.getJSONObject("data");
        assertEquals("a.txt", data.getString("name"));
        assertEquals("dist/a.txt", data.getString("path"));
        assertEquals(5, data.getLong("size"));
        assertFalse(data.getBoolean("binary"));
        assertFalse(data.getBoolean("truncated"));
        assertEquals("hello", data.getString("text"));

        // Directories, missing files and traversal are rejected
        assertEquals("error", json(wc, "job/p/1/artifact-explorer/preview?path=dist").getString("status"));
        assertEquals("error", json(wc, "job/p/1/artifact-explorer/preview?path=dist/nope.txt").getString("status"));
        assertEquals("error", json(wc, "job/p/1/artifact-explorer/preview?path=../x").getString("status"));

        // Direct truncation check on ArtifactTree.preview
        ArtifactTree.FilePreview truncated = ArtifactTree.preview(p.getLastBuild(), "dist/a.txt", 3);
        assertNotNull(truncated);
        assertTrue(truncated.truncated());
        assertEquals("hel", truncated.text());
    }

    @Test
    void itemReadPermissionIsEnforcedByDefault(JenkinsRule j) throws Exception {
        projectWithArtifacts(j, "p-read-perm");
        j.jenkins.setSecurityRealm(j.createDummySecurityRealm());
        j.jenkins.setAuthorizationStrategy(new MockAuthorizationStrategy()
                .grant(Jenkins.READ)
                .everywhere()
                .to("anonymous")
                .grant(Jenkins.READ, Item.READ)
                .everywhere()
                .to("reader"));

        JenkinsRule.WebClient anon = client(j);
        anon.assertFails("job/p-read-perm/1/artifact-explorer/tree?path=dist", 404);
        anon.assertFails("job/p-read-perm/1/artifact-explorer/searchIndex", 404);
        anon.assertFails("job/p-read-perm/1/artifact-explorer/preview?path=dist/a.txt", 404);
        anon.assertFails("job/p-read-perm/1/artifact-explorer/", 404);

        JenkinsRule.WebClient reader = client(j).login("reader");
        assertEquals("ok", json(reader, "job/p-read-perm/1/artifact-explorer/tree?path=dist").getString("status"));
        assertEquals("ok", json(reader, "job/p-read-perm/1/artifact-explorer/searchIndex").getString("status"));
    }

    @Test
    void emptyBuildHandledGracefully(JenkinsRule j) throws Exception {
        FreeStyleProject empty = j.createFreeStyleProject("empty-build");
        j.buildAndAssertSuccess(empty);
        Run<?, ?> run = empty.getLastBuild();

        // Direct calls on ArtifactTree with non-existent artifact dir
        var children = ArtifactTree.children(run, "", 10);
        assertNotNull(children);
        assertEquals(0, children.items().size());
        assertFalse(children.truncated());

        var all = ArtifactTree.allFiles(run, 10);
        assertNotNull(all);
        assertEquals(0, all.items().size());
        assertFalse(all.truncated());

        assertEquals(null, ArtifactTree.preview(run, "does-not-exist.txt", 1024));

        // Via HTTP JSON API
        JenkinsRule.WebClient wc = client(j);
        JSONObject tree = json(wc, "job/empty-build/1/artifact-explorer/tree?path=");
        assertEquals("ok", tree.getString("status"));
        assertEquals(0, tree.getJSONObject("data").getJSONArray("entries").size());

        JSONObject search = json(wc, "job/empty-build/1/artifact-explorer/searchIndex");
        assertEquals("ok", search.getString("status"));
        assertEquals(0, search.getJSONObject("data").getJSONArray("files").size());
    }

    @Test
    void binaryFilesAreCorrectlyIdentified(JenkinsRule j) throws Exception {
        FreeStyleProject p = j.createFreeStyleProject("binary-job");
        p.getBuildersList().add(new TestBuilder() {
            @Override
            public boolean perform(AbstractBuild<?, ?> build, Launcher launcher, BuildListener listener)
                    throws InterruptedException, IOException {
                FilePath ws = build.getWorkspace();
                ws.child("data.bin").copyFrom(new java.io.ByteArrayInputStream(new byte[] { 0x01, 0x00, 0x02, 0x03 }));
                return true;
            }
        });
        p.getPublishersList().add(new ArtifactArchiver("data.bin"));
        j.buildAndAssertSuccess(p);

        JenkinsRule.WebClient wc = client(j);
        JSONObject res = json(wc, "job/binary-job/1/artifact-explorer/preview?path=data.bin");
        assertEquals("ok", res.getString("status"));
        JSONObject data = res.getJSONObject("data");
        assertTrue(data.getBoolean("binary"));
        assertEquals(null, data.opt("text"));
    }
}
