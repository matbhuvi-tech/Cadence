package com.cadence.remote;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.net.SocketTimeoutException;
import org.junit.Test;

public class CadencePinnedStoreTest {

    @Test
    public void privateAndLocalHostsAreAllowedForHttp() {
        assertTrue(CadencePinnedStore.isPrivateOrLocalHost("192.168.1.42"));
        assertTrue(CadencePinnedStore.isPrivateOrLocalHost("10.0.0.5"));
        assertTrue(CadencePinnedStore.isPrivateOrLocalHost("172.16.0.10"));
        assertTrue(CadencePinnedStore.isPrivateOrLocalHost("studio-pc.local"));
        assertTrue(CadencePinnedStore.isPrivateOrLocalHost("localhost"));
        assertTrue(CadencePinnedStore.isPrivateOrLocalHost("127.0.0.1"));

        assertFalse(CadencePinnedStore.isPrivateOrLocalHost("example.com"));
        assertFalse(CadencePinnedStore.isPrivateOrLocalHost("8.8.8.8"));
        assertFalse(CadencePinnedStore.isPrivateOrLocalHost(""));
    }

    @Test
    public void fingerprintNormalizationStripsDelimitersAndLowercases() {
        assertEquals(
            "abcdef0123456789",
            CadencePinnedStore.normalizeFingerprint("AB:CD:EF-01:23:45:67:89")
        );
    }

    @Test
    public void exceptionClassificationAndFingerprintExtractionWork() {
        assertEquals("unauthorized", CadenceRemoteStateHolder.classifyThrowable(null, 401));
        assertEquals("timeout", CadenceRemoteStateHolder.classifyThrowable(new SocketTimeoutException("timed out"), 0));

        String fp = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        Exception certErr = new Exception("CADENCE_CERT_MISMATCH:" + fp);
        assertEquals("cert_mismatch", CadenceRemoteStateHolder.classifyThrowable(certErr, 0));
        assertEquals(fp.toLowerCase(), CadenceRemoteStateHolder.extractObservedFingerprint(certErr));
    }
}

