package com.cadence.remote;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(CadenceRemotePlugin.class);
        super.onCreate(savedInstanceState);
        if (this.bridge != null) {
            this.bridge.setWebViewClient(new CadenceWebViewClient(this.bridge));
        }
    }
}
