Clean URL fix for method-comparison pages
========================================

Problem observed
----------------
Opening:
  https://droughtanalysis.com/method-comparison/phoenix-arizona/
redirected to:
  https://droughtanalysis.com/method-comparison/phoenix-arizona/index

Cause
-----
This is caused by the hosting/server rewrite rule or default-document behavior.
The HTML page itself is not supposed to redirect to /index.

What changed in this package
----------------------------
1. Removed the JavaScript clean-URL redirect from:
   /method-comparison/comparison-nav.js
   This stops the browser redirect loop.

2. Added server-side clean URL examples:
   /web.config     for IIS / Windows hosting
   /.htaccess      for Apache hosting
   /_redirects     for Netlify-style hosting

Upload instructions
-------------------
1. Upload all files from this package to the website root.
2. Make sure web.config or .htaccess is uploaded if your server supports it.
3. Clear browser cache or test in an incognito window.
4. Open:
   https://droughtanalysis.com/method-comparison/phoenix-arizona/

Important
---------
If the URL still changes to /index after upload, your hosting account probably already has a global rule that removes .html from all files. That rule must exclude index.html.

Correct logic:
  /folder/index.html  -> /folder/
  /folder/            -> internally serve /folder/index.html

Wrong logic causing your issue:
  /folder/index.html  -> /folder/index
