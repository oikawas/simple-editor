import SimpleEditorModel
import SwiftUI

/// A month grid starting on Sunday. Days with an entry carry a dot; picking a
/// day opens its entry.
struct DiaryCalendarView: View {
    @Environment(AppModel.self) private var model

    /// One grid cell. The grid needs ids unique across all its cells: with
    /// plain numbers, the weekday labels (0-6) and days 1-6 collide, and the
    /// grid drops those days.
    private enum Cell: Hashable {
        case weekday(Int)
        case blank(Int)
        case day(Int)
    }

    var body: some View {
        let month = model.shownMonth
        let written = model.writtenDays
        let selected = model.current?.diaryDate
        let today = Diary.today
        VStack(spacing: 6) {
            HStack {
                Button { model.shownMonth = month.adding(months: -1) } label: {
                    Image(systemName: "chevron.left")
                }
                .help("前の月")
                Spacer()
                Text(verbatim: "\(month.year)年\(month.month)月")
                    .font(.headline)
                Spacer()
                Button { model.shownMonth = month.adding(months: 1) } label: {
                    Image(systemName: "chevron.right")
                }
                .help("次の月")
            }
            .buttonStyle(.borderless)
            let cells = (0..<7).map(Cell.weekday)
                + (0..<month.firstWeekday).map(Cell.blank)
                + (1...month.numberOfDays).map(Cell.day)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 2), count: 7), spacing: 2) {
                ForEach(cells, id: \.self) { cell in
                    switch cell {
                    case .weekday(let i):
                        Text(Diary.weekdays[i])
                            .font(.caption2)
                            .foregroundStyle(Self.weekdayColor(i) ?? .secondary)
                    case .blank:
                        // Before the 1st.
                        Color.clear.frame(height: 1)
                    case .day(let day):
                        let date = month.date(day: day)
                        dayCell(
                            day: day,
                            date: date,
                            // Holidays are colored like Sundays.
                            weekday: Diary.holiday(date) != nil ? 0 : (month.firstWeekday + day - 1) % 7,
                            isSelected: date == selected,
                            isToday: date == today,
                            isWritten: written.contains(day)
                        ) {
                            model.openDiary(date: date)
                        }
                    }
                }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 6)
    }

    private func dayCell(
        day: Int, date: String, weekday: Int, isSelected: Bool, isToday: Bool, isWritten: Bool, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Text(verbatim: "\(day)")
                    .font(.callout)
                    .fontWeight(isToday ? .bold : .regular)
                Circle()
                    .fill(isWritten ? (isSelected ? Color.white : Color.accentColor) : Color.clear)
                    .frame(width: 4, height: 4)
            }
            .frame(maxWidth: .infinity, minHeight: 32)
            .foregroundStyle(isSelected ? Color.white : (Self.weekdayColor(weekday) ?? Color.primary))
            .background(isSelected ? Color.accentColor : Color.clear, in: RoundedRectangle(cornerRadius: 8))
            .overlay {
                if isToday && !isSelected {
                    RoundedRectangle(cornerRadius: 8).strokeBorder(Color.accentColor)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(Diary.format(date)))
    }

    private static func weekdayColor(_ weekday: Int) -> Color? {
        switch weekday {
        case 0: Color.red.opacity(0.8)
        case 6: Color.blue.opacity(0.8)
        default: nil
        }
    }
}
