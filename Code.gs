// 구글 시트 직통 데이터 누적 저장용 수신기 (doPost)
function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("시트1") || ss.getSheets()[0];
    var data = JSON.parse(e.postData.contents);
    for (var i = 0; i < data.length; i++) {
      sheet.appendRow([data[i].word, data[i].form, data[i].meaning, data[i].day]);
    }
    return ContentService.createTextOutput(JSON.stringify({result: "success", count: data.length}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(e) {
    return ContentService.createTextOutput(JSON.stringify({result: "error", error: e.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}