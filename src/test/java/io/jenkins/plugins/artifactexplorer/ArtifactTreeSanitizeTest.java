package io.jenkins.plugins.artifactexplorer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class ArtifactTreeSanitizeTest {

    @Test
    void emptyAndNullAreTheRoot() {
        assertEquals("", ArtifactTree.sanitize(null));
        assertEquals("", ArtifactTree.sanitize(""));
        assertEquals("", ArtifactTree.sanitize("/"));
    }

    @Test
    void normalizesSlashes() {
        assertEquals("dist/sub", ArtifactTree.sanitize("/dist//sub/"));
        assertEquals("a b/c", ArtifactTree.sanitize("a b/c"));
    }

    @Test
    void rejectsTraversal() {
        assertThrows(IllegalArgumentException.class, () -> ArtifactTree.sanitize(".."));
        assertThrows(IllegalArgumentException.class, () -> ArtifactTree.sanitize("a/../b"));
        assertThrows(IllegalArgumentException.class, () -> ArtifactTree.sanitize("./a"));
        assertThrows(IllegalArgumentException.class, () -> ArtifactTree.sanitize("a/.."));
    }

    @Test
    void rejectsBackslashAndNul() {
        assertThrows(IllegalArgumentException.class, () -> ArtifactTree.sanitize("a\\b"));
        assertThrows(IllegalArgumentException.class, () -> ArtifactTree.sanitize("a\0b"));
    }

    @Test
    void directoryRequestPatternOnlyMatchesDirectoryPages() {
        var p = ArtifactExplorerFilter.DIRECTORY_REQUEST;
        assertEquals(true, p.matcher("/job/x/46/artifact/dist/").matches());
        assertEquals(true, p.matcher("/job/x/46/artifact/").matches());
        assertEquals(true, p.matcher("/job/f/job/x/lastSuccessfulBuild/artifact/a/b/").matches());
        assertEquals(true, p.matcher("/view/all/job/x/3/artifact/").matches());
        assertEquals(true, p.matcher("/job/artifact/5/artifact/dist/").matches());
        // files, special tokens and non-build URLs are left to core
        assertEquals(false, p.matcher("/job/x/46/artifact/dist/a.txt").matches());
        assertEquals(false, p.matcher("/job/x/46/artifact/dist/*zip*/dist.zip").matches());
        assertEquals(false, p.matcher("/job/x/46/artifact/dist/a.txt/*view*/").matches());
        assertEquals(false, p.matcher("/job/x/46/artifact").matches());
        assertEquals(false, p.matcher("/job/x/ws/dist/").matches());
    }

    @Test
    void jobNamedArtifactIsNotConfusedWithTheArtifactSegment() {
        var m = ArtifactExplorerFilter.DIRECTORY_REQUEST.matcher("/job/artifact/5/artifact/job/b/6/artifact/");
        assertEquals(true, m.matches());
        assertEquals("/job/artifact/5", m.group(1));
        assertEquals("job/b/6/artifact/", m.group(2));
    }
}
