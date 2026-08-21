const { app, desktopCapturer, screen } = require('electron');
app.whenReady().then(async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    console.log(JSON.stringify(sources, null, 2));
    const pId = String(screen.getPrimaryDisplay().id);
    console.log("Primary Display ID:", pId);
  } catch (e) {
    console.error(e);
  }
  app.quit();
});
