const { app, BrowserWindow, session, desktopCapturer, screen } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then(sources => {
      callback({ video: sources[0], audio: 'loopback' });
    });
  }, { useSystemPicker: false });

  const win = new BrowserWindow({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadURL('data:text/html,' + encodeURIComponent(`
    <html><body>
    <script>
      (async () => {
        try {
          const start = Date.now();
          const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
          const video = document.createElement('video');
          video.muted = true;
          video.srcObject = new MediaStream([stream.getVideoTracks()[0]]);
          await video.play();

          const check = () => {
            if (video.readyState >= 2 && video.videoWidth > 0) {
              const el = document.createElement('h1');
              el.innerText = 'Frame received in ' + (Date.now() - start) + 'ms';
              document.body.appendChild(el);

              // send back to main process to print
              const { ipcRenderer } = require('electron');
              ipcRenderer.send('done', Date.now() - start);
            } else {
              setTimeout(check, 50);
            }
          };
          check();
        } catch (e) {
          const { ipcRenderer } = require('electron');
          ipcRenderer.send('error', e.message);
        }
      })();
    </script>
    </body></html>
  `));

  const { ipcMain } = require('electron');
  ipcMain.on('done', (e, ms) => {
    console.log('Frame received in', ms, 'ms');
    app.quit();
  });
  ipcMain.on('error', (e, msg) => {
    console.error('Error:', msg);
    app.quit();
  });
});
