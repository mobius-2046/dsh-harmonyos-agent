@Entry
@Component
struct Index {
  @State taps: number = 0;

  build() {
    Column({ space: 16 }) {
      Text($r('app.string.greeting'))
        .fontSize(28)
        .fontWeight(FontWeight.Bold)
      Text($r('app.string.hint'))
        .fontSize(14)
        .fontColor('#666666')
        .textAlign(TextAlign.Center)
      Text($r('app.string.counter', this.taps))
        .fontSize(18)
      Button($r('app.string.tap_me'))
        .width(160)
        .height(44)
        .onClick(() => {
          this.taps += 1;
          console.info(`hello-app: tap ${this.taps}`);
        })
    }
    .width('100%')
    .height('100%')
    .padding(24)
    .justifyContent(FlexAlign.Center)
  }
}
