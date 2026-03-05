// DuplicateFilter.java - Burp Extension
package burp;

import java.util.HashSet;
import java.util.Set;

public class DuplicateFilter implements IBurpExtender, IHttpListener, IExtensionStateListener {
    
    private IBurpExtenderCallbacks callbacks;
    private IExtensionHelpers helpers;
    private Set<String> requestHashes = new HashSet<>();
    private Set<String> responseHashes = new HashSet<>();
    
    @Override
    public void registerExtenderCallbacks(IBurpExtenderCallbacks callbacks) {
        this.callbacks = callbacks;
        this.helpers = callbacks.getHelpers();
        callbacks.setExtensionName("Duplicate Filter");
        
        // Register listeners
        callbacks.registerHttpListener(this);
        callbacks.registerExtensionStateListener(this);
        
        callbacks.printOutput("Duplicate Filter loaded");
    }
    
    @Override
    public void processHttpMessage(int toolFlag, boolean messageIsRequest, 
                                   IHttpRequestResponse messageInfo) {
        
        if (toolFlag == IBurpExtenderCallbacks.TOOL_PROXY || 
            toolFlag == IBurpExtenderCallbacks.TOOL_REPEATER) {
            
            if (messageIsRequest) {
                // Filter duplicate requests
                String requestHash = generateRequestHash(messageInfo);
                if (requestHashes.contains(requestHash)) {
                    // Mark as duplicate
                    messageInfo.setComment("DUPLICATE_REQUEST");
                    callbacks.printOutput("Filtered duplicate request: " + requestHash);
                } else {
                    requestHashes.add(requestHash);
                }
            } else {
                // Filter duplicate responses
                String responseHash = generateResponseHash(messageInfo);
                if (responseHashes.contains(responseHash)) {
                    messageInfo.setComment("DUPLICATE_RESPONSE");
                    callbacks.printOutput("Filtered duplicate response: " + responseHash);
                } else {
                    responseHashes.add(responseHash);
                }
            }
        }
    }
    
    private String generateRequestHash(IHttpRequestResponse message) {
        byte[] request = message.getRequest();
        IRequestInfo info = helpers.analyzeRequest(request);
        
        // Create hash based on method, URL, and parameters
        String hashData = info.getMethod() + ":" + info.getUrl().toString();
        return helpers.hash(hashData.getBytes());
    }
    
    private String generateResponseHash(IHttpRequestResponse message) {
        byte[] response = message.getResponse();
        if (response == null) return "";
        
        IResponseInfo info = helpers.analyzeResponse(response);
        
        // Create hash based on status code and body hash
        String hashData = info.getStatusCode() + ":" + 
                         helpers.hash(helpers.stringToBytes(
                             helpers.bytesToString(response).substring(info.getBodyOffset())
                         ));
        return helpers.hash(hashData.getBytes());
    }
    
    @Override
    public void extensionUnloaded() {
        requestHashes.clear();
        responseHashes.clear();
        callbacks.printOutput("Duplicate Filter unloaded");
    }
}
