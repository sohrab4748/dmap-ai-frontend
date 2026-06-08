DMAP-AI method-comparison structure
===================================

Recommended public URLs
-----------------------
Main comparison landing page:
  /method-comparison/

Phoenix station page:
  /method-comparison/phoenix-arizona/

Folder structure
----------------
- /method-comparison/index.html
- /method-comparison/stations.json
- /method-comparison/comparison-nav.js
- /method-comparison/comparison-style.css
- /method-comparison/{city-state}/index.html
- /method-comparison/{city-state}/images/

How to add a new station
------------------------
1. Create a new station folder, for example:
   /method-comparison/ames-iowa/

2. Put the page here:
   /method-comparison/ames-iowa/index.html

3. Put charts here:
   /method-comparison/ames-iowa/images/

4. Add the station to:
   /method-comparison/stations.json

5. Use this URL format in stations.json:
   /method-comparison/ames-iowa/

Clean URL note
--------------
If your server changes:
  /method-comparison/phoenix-arizona/
into:
  /method-comparison/phoenix-arizona/index

then the issue is server-side, not inside the HTML page.
The root of this package includes web.config and .htaccess examples to stop that behavior.
The JavaScript redirect was removed to avoid a browser redirect loop.

For IIS/Windows hosting, upload web.config to the website root.
For Apache hosting, upload .htaccess to the website root.

If your hosting already has a rewrite rule that removes .html, make sure it excludes index.html or redirects index.html to the folder URL.
